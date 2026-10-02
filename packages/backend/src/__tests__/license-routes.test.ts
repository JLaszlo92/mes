import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A throwaway self-signed certificate standing in for the device CA root.
const CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBsDCCAVWgAwIBAgIUWyWvsdbGcyVPeOt2+z5dArOdHf8wCgYIKoZIzj0EAwIw
LDERMA8GA1UECgwITUVTIFRlc3QxFzAVBgNVBAMMDlRlc3QgRGV2aWNlIENBMCAX
DTI2MTAwMjE0MTIyOVoYDzIxMjYwOTA4MTQxMjI5WjAsMREwDwYDVQQKDAhNRVMg
VGVzdDEXMBUGA1UEAwwOVGVzdCBEZXZpY2UgQ0EwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQHbTg1Fx2l043RYXQDuQMs/X1isj4JaeG+oQ7x6fxTXckU1AS9gP/u
aGScuTD2xPo9YK+9IiQd21Nb3dGHAXvpo1MwUTAdBgNVHQ4EFgQU4Wm7QL7pqW0S
OIy/JNQXjXicR6owHwYDVR0jBBgwFoAU4Wm7QL7pqW0SOIy/JNQXjXicR6owDwYD
VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEAuBwMCENqLCC8P7rXxdM/
u/q7+ZwYQHWqreDFoN9urEgCIQCnsx97lrjBJVX6pfF2aUub9HZaVPAW2cigvumr
xANkkA==
-----END CERTIFICATE-----
`;

const DAY = 86_400_000;
let edgeNodeCount = 2;

vi.mock("../db.js", () => ({
  pool: {
    query: async (sql: string) => {
      if (sql.includes("FROM license_state")) return { rows: [{ max_serial: 0, last_seen_at: new Date(0) }] };
      if (sql.includes("count(*)")) return { rows: [{ n: edgeNodeCount }] };
      return { rows: [] };
    },
  },
}));
vi.mock("../alerts-repository.js", () => ({
  raiseOrUpdateSystemAlert: async () => true,
  resolveSystemAlert: async () => false,
}));
vi.mock("../auth-plugin.js", () => ({ requireRole: () => async () => {} }));

async function setup(opts: { enforce: boolean; validUntilDays: number; check?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "lic-"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const { createHash, X509Certificate } = await import("node:crypto");
  const fp = createHash("sha256").update(new X509Certificate(CA_PEM).raw).digest("hex");
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({
    v: 1, licenseId: "lic-t", customer: "T", serial: 1,
    issuedAt: new Date(now - 400 * DAY).toISOString(),
    validFrom: new Date(now - 400 * DAY).toISOString(),
    validUntil: new Date(now + opts.validUntilDays * DAY).toISOString(),
    graceDays: 14, deviceCaSha256: fp, limits: { edgeNodes: 2, terminals: 5 },
  }));
  const sig = sign(null, Buffer.concat([Buffer.from("mes-license-v1\n"), payload]), privateKey);
  writeFileSync(join(dir, "license.json"), JSON.stringify({ format: "mes-license-v1", payload: payload.toString("base64url"), signature: sig.toString("base64url") }));
  writeFileSync(join(dir, "license.pub"), publicKey.export({ type: "spki", format: "pem" }));
  writeFileSync(join(dir, "ca.pem"), CA_PEM);
  vi.stubEnv("LICENSE_FILE", join(dir, "license.json"));
  vi.stubEnv("LICENSE_PUBLIC_KEY_FILE", join(dir, "license.pub"));
  vi.stubEnv("LICENSE_DEVICE_CA_FILE", join(dir, "ca.pem"));
  vi.stubEnv("LICENSE_ENFORCE", opts.enforce ? "true" : "false");
  vi.resetModules();
  const { registerLicense } = await import("../license-routes.js");
  const { refreshLicense } = await import("../license-service.js");
  const app = Fastify();
  for (const [m, url] of [
    ["POST", "/api/machine-registry"], ["POST", "/api/edge-nodes"], ["POST", "/api/edge-nodes/heartbeat"],
    ["POST", "/api/fault-reports"], ["DELETE", "/api/edge-nodes/:id"],
  ] as const) {
    app.route({ method: m, url, handler: async () => ({ ok: true }) });
  }
  registerLicense(app);
  await app.ready();
  if (opts.check !== false) await refreshLicense(app.log);
  const call = async (method: "POST" | "DELETE", url: string) => (await app.inject({ method, url })).statusCode;
  return { app, call };
}

beforeEach(() => { edgeNodeCount = 2; });
afterEach(() => { vi.unstubAllEnvs(); });

describe("license guard", () => {
  it("expired + enforce: blocks configuration, never the data path", async () => {
    const { app, call } = await setup({ enforce: true, validUntilDays: -30 });
    expect(await call("POST", "/api/machine-registry")).toBe(403);
    expect(await call("POST", "/api/edge-nodes")).toBe(403);
    expect(await call("POST", "/api/fault-reports")).toBe(200);
    expect(await call("POST", "/api/edge-nodes/heartbeat")).toBe(200);
    expect(await call("DELETE", "/api/edge-nodes/:id")).toBe(200);
    const body = (await app.inject({ method: "POST", url: "/api/machine-registry" })).json();
    expect(body.error).toBe("license_restricted");
  });

  it("valid + enforce: configuration allowed, node creation stops at the limit", async () => {
    const { call } = await setup({ enforce: true, validUntilDays: 200 });
    expect(await call("POST", "/api/machine-registry")).toBe(200);
    expect(await call("POST", "/api/edge-nodes")).toBe(403); // 2 of 2 used
    edgeNodeCount = 1;
    expect(await call("POST", "/api/edge-nodes")).toBe(200);
  });

  it("grace period behaves like valid", async () => {
    const { call } = await setup({ enforce: true, validUntilDays: -3 });
    expect(await call("POST", "/api/machine-registry")).toBe(200);
  });

  it("audit mode (enforce=false) never blocks, even when expired", async () => {
    const { call } = await setup({ enforce: false, validUntilDays: -30 });
    expect(await call("POST", "/api/machine-registry")).toBe(200);
    expect(await call("POST", "/api/edge-nodes")).toBe(200);
  });

  it("does not block before the first check finished", async () => {
    const { call } = await setup({ enforce: true, validUntilDays: -30, check: false });
    expect(await call("POST", "/api/machine-registry")).toBe(200);
  });

  it("a missing license file with enforce=true restricts configuration only", async () => {
    const { call } = await setup({ enforce: true, validUntilDays: 200 });
    vi.stubEnv("LICENSE_FILE", "/nonexistent/license.json");
    vi.resetModules();
    const { registerLicense } = await import("../license-routes.js");
    const { refreshLicense } = await import("../license-service.js");
    const app = Fastify();
    app.route({ method: "POST", url: "/api/machine-registry", handler: async () => ({ ok: true }) });
    app.route({ method: "POST", url: "/api/fault-reports", handler: async () => ({ ok: true }) });
    registerLicense(app);
    await app.ready();
    await refreshLicense(app.log);
    expect((await app.inject({ method: "POST", url: "/api/machine-registry" })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/fault-reports" })).statusCode).toBe(200);
    void call;
  });
});
