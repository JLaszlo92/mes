import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

class InvalidTokenError extends Error {
  constructor() { super("invalid token"); }
}
const repo = {
  releaseSession: vi.fn(),
  getEdgeNodeSettings: vi.fn(),
  updateEdgeNodeSettings: vi.fn(),
};
const audit = vi.fn(async () => {});

vi.mock("../edge-nodes-repository.js", () => ({ ...repo, InvalidTokenError }));
vi.mock("../audit-repository.js", () => ({ recordAuditEvent: audit }));
vi.mock("../auth-plugin.js", () => ({ requireRole: () => async () => {} }));

async function app() {
  const { registerEdgeNodeExtras } = await import("../edge-node-routes.js");
  const a = Fastify();
  a.addHook("onRequest", async (request) => { (request as any).user = { id: "u1", email: "a@b.hu" }; });
  registerEdgeNodeExtras(a);
  await a.ready();
  return a;
}

beforeEach(() => { vi.clearAllMocks(); });

describe("POST /api/edge-nodes/release", () => {
  it("releases", async () => {
    repo.releaseSession.mockResolvedValue("released");
    const r = await (await app()).inject({ method: "POST", url: "/api/edge-nodes/release", payload: { token: "t", sessionId: "s" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ success: true, released: true });
    expect(repo.releaseSession).toHaveBeenCalledWith("t", "s");
  });
  it("is not an error when the session is no longer current", async () => {
    repo.releaseSession.mockResolvedValue("not_current");
    const r = await (await app()).inject({ method: "POST", url: "/api/edge-nodes/release", payload: { token: "t", sessionId: "s" } });
    expect(r.json()).toEqual({ success: true, released: false });
  });
  it("400 without fields, 401 for a bad token", async () => {
    const a = await app();
    expect((await a.inject({ method: "POST", url: "/api/edge-nodes/release", payload: { token: "t" } })).statusCode).toBe(400);
    repo.releaseSession.mockRejectedValue(new InvalidTokenError());
    expect((await a.inject({ method: "POST", url: "/api/edge-nodes/release", payload: { token: "x", sessionId: "s" } })).statusCode).toBe(401);
  });
});

describe("settings routes", () => {
  it("GET returns settings or 404", async () => {
    const a = await app();
    repo.getEdgeNodeSettings.mockResolvedValue({ catchupMaxMinutes: 10 });
    expect((await a.inject({ method: "GET", url: "/api/edge-nodes/n1/settings" })).json()).toEqual({ catchupMaxMinutes: 10 });
    repo.getEdgeNodeSettings.mockResolvedValue(null);
    expect((await a.inject({ method: "GET", url: "/api/edge-nodes/n2/settings" })).statusCode).toBe(404);
  });
  it("PATCH validates, saves and audits", async () => {
    const a = await app();
    repo.updateEdgeNodeSettings.mockResolvedValue({ catchupMaxMinutes: 25 });
    const ok = await a.inject({ method: "PATCH", url: "/api/edge-nodes/n1/settings", payload: { catchupMaxMinutes: 25 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ catchupMaxMinutes: 25 });
    expect(repo.updateEdgeNodeSettings).toHaveBeenCalledWith("n1", { catchupMaxMinutes: 25 });
    expect(audit).toHaveBeenCalledTimes(1);
    expect((audit.mock.calls[0] as any)[0].action).toBe("edge_node_settings_updated");
    const bad = await a.inject({ method: "PATCH", url: "/api/edge-nodes/n1/settings", payload: { catchupMaxMinutes: -3 } });
    expect(bad.statusCode).toBe(400);
    expect(audit).toHaveBeenCalledTimes(1);
  });
  it("PATCH 404 for an unknown node writes no audit", async () => {
    repo.updateEdgeNodeSettings.mockResolvedValue(null);
    const r = await (await app()).inject({ method: "PATCH", url: "/api/edge-nodes/zz/settings", payload: { catchupMaxMinutes: 5 } });
    expect(r.statusCode).toBe(404);
    expect(audit).not.toHaveBeenCalled();
  });
});
