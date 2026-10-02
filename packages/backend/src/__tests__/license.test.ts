import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LICENSE_FORMAT,
  mayAddDevice,
  mayChangeConfiguration,
  verifyLicense,
  type LicensePayload,
} from "../license.js";

const CA = "a".repeat(64);
const DAY = 86_400_000;
const NOW = new Date("2026-10-02T12:00:00.000Z");

const vendor = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const pub = vendor.publicKey.export({ type: "spki", format: "pem" }).toString();

function payload(over: Partial<LicensePayload> = {}): LicensePayload {
  return {
    v: 1,
    licenseId: "lic-test",
    customer: "Pilot Kft.",
    serial: 3,
    issuedAt: "2026-10-01T00:00:00.000Z",
    validFrom: new Date(NOW.getTime() - 100 * DAY).toISOString(),
    validUntil: new Date(NOW.getTime() + 30 * DAY).toISOString(),
    graceDays: 14,
    deviceCaSha256: CA,
    limits: { edgeNodes: 2, terminals: 5 },
    ...over,
  };
}

function file(p: unknown, key: KeyObject = vendor.privateKey): string {
  const bytes = Buffer.from(JSON.stringify(p));
  const sig = sign(null, Buffer.concat([Buffer.from(`${LICENSE_FORMAT}\n`), bytes]), key);
  return JSON.stringify({ format: LICENSE_FORMAT, payload: bytes.toString("base64url"), signature: sig.toString("base64url") });
}

const opts = (over: Record<string, unknown> = {}) => ({ publicKeyPem: pub, deviceCaSha256: CA, now: NOW, ...over });

describe("verifyLicense", () => {
  it("accepts a good license", () => {
    const s = verifyLicense(file(payload()), opts());
    expect(s.state).toBe("valid");
    expect(s.daysLeft).toBe(30);
    expect(s.payload?.limits.edgeNodes).toBe(2);
  });

  it("enters the grace period after validUntil", () => {
    const p = payload({ validUntil: new Date(NOW.getTime() - 3 * DAY).toISOString() });
    const s = verifyLicense(file(p), opts());
    expect(s.state).toBe("grace");
    expect(s.daysLeft).toBe(11);
    expect(mayChangeConfiguration(s)).toBe(true);
  });

  it("expires after the grace period and becomes read-only", () => {
    const p = payload({ validUntil: new Date(NOW.getTime() - 15 * DAY).toISOString() });
    const s = verifyLicense(file(p), opts());
    expect(s.state).toBe("expired");
    expect(mayChangeConfiguration(s)).toBe(false);
    expect(mayAddDevice(s, "edgeNode", 0).allowed).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const good = JSON.parse(file(payload()));
    const forged = Buffer.from(JSON.stringify(payload({ limits: { edgeNodes: 99, terminals: 99 } }))).toString("base64url");
    const s = verifyLicense(JSON.stringify({ ...good, payload: forged }), opts());
    expect(s.state).toBe("invalid");
    expect(s.reason).toMatch(/signature/);
  });

  it("rejects a license signed with another key", () => {
    expect(verifyLicense(file(payload(), other.privateKey), opts()).state).toBe("invalid");
  });

  it("rejects a license for another installation", () => {
    const s = verifyLicense(file(payload({ deviceCaSha256: "b".repeat(64) })), opts());
    expect(s.state).toBe("invalid");
    expect(s.reason).toMatch(/different installation/);
  });

  it("rejects a rolled-back (older) serial", () => {
    expect(verifyLicense(file(payload({ serial: 2 })), opts({ minSerial: 3 })).state).toBe("invalid");
    expect(verifyLicense(file(payload({ serial: 3 })), opts({ minSerial: 3 })).state).toBe("valid");
  });

  it("rejects a license that is not valid yet (beyond a one-day tolerance)", () => {
    const p = payload({ validFrom: new Date(NOW.getTime() + 5 * DAY).toISOString(), validUntil: new Date(NOW.getTime() + 40 * DAY).toISOString() });
    expect(verifyLicense(file(p), opts()).state).toBe("invalid");
  });

  it("rejects garbage, wrong format and unsupported versions", () => {
    expect(verifyLicense("not json", opts()).state).toBe("invalid");
    expect(verifyLicense(JSON.stringify({ format: "x" }), opts()).state).toBe("invalid");
    expect(verifyLicense(file({ ...payload(), v: 2 }), opts()).state).toBe("invalid");
    expect(verifyLicense(file({ ...payload(), limits: { edgeNodes: -1, terminals: 1 } }), opts()).state).toBe("invalid");
  });

  it("rejects an invalid public key without throwing", () => {
    expect(verifyLicense(file(payload()), opts({ publicKeyPem: "nonsense" })).state).toBe("invalid");
  });
});

describe("mayAddDevice", () => {
  const valid = () => verifyLicense(file(payload()), opts());

  it("allows below the limit and refuses at it", () => {
    expect(mayAddDevice(valid(), "edgeNode", 1).allowed).toBe(true);
    const full = mayAddDevice(valid(), "edgeNode", 2);
    expect(full.allowed).toBe(false);
    expect(full.reason).toMatch(/2\/2/);
  });

  it("uses the terminal limit for terminals", () => {
    expect(mayAddDevice(valid(), "terminal", 4).allowed).toBe(true);
    expect(mayAddDevice(valid(), "terminal", 5).allowed).toBe(false);
  });
});
