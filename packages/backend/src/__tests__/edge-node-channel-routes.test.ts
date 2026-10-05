import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

class InvalidTokenError extends Error {}
const repo = {
  releaseSession: vi.fn(),
  getEdgeNodeSettings: vi.fn(),
  updateEdgeNodeSettings: vi.fn(),
  getChannel: vi.fn(),
  updateChannel: vi.fn(),
  isForeignKeyViolation: vi.fn((e: any) => e?.code === "23503"),
};
const audit = vi.fn(async (_e: unknown) => {});

vi.mock("../edge-nodes-repository.js", () => ({ ...repo, InvalidTokenError }));
vi.mock("../audit-repository.js", () => ({ recordAuditEvent: audit }));
vi.mock("../auth-plugin.js", () => ({ requireRole: () => async () => {} }));

const channel = {
  id: "c1", edgeNodeId: "n1", machineId: "m1", machineName: "Press 1", signalSource: "modbus" as const,
  connectionConfig: { host: "10.0.0.5", port: 502 }, statusMode: "status_bit" as const,
  noSignalTimeoutSeconds: 60, acceptProductionWhileDown: true,
};

async function app() {
  const { registerEdgeNodeExtras } = await import("../edge-node-routes.js");
  const a = Fastify();
  a.addHook("onRequest", async (request) => { (request as any).user = { id: "u1", email: "a@b.hu" }; });
  registerEdgeNodeExtras(a);
  await a.ready();
  return a;
}
const patch = async (body: unknown) =>
  (await app()).inject({ method: "PATCH", url: "/api/edge-node-channels/c1", payload: body as any });

beforeEach(() => { vi.clearAllMocks(); repo.getChannel.mockResolvedValue(channel); });

describe("PATCH /api/edge-node-channels/:id", () => {
  it("validates, saves the merged channel and audits the diff", async () => {
    repo.updateChannel.mockResolvedValue({ ...channel, connectionConfig: { host: "10.0.0.9", port: 502 } });
    const r = await patch({ connectionConfig: { host: "10.0.0.9" } });
    expect(r.statusCode).toBe(200);
    expect(repo.updateChannel).toHaveBeenCalledWith("c1", {
      machineId: "m1", signalSource: "modbus", connectionConfig: { host: "10.0.0.9", port: 502 },
      statusMode: "status_bit", noSignalTimeoutSeconds: 60, acceptProductionWhileDown: true,
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "u1", action: "edge_node_channel_updated", target: "c1",
      details: { changes: { "connectionConfig.host": { from: "10.0.0.5", to: "10.0.0.9" } } },
    }));
  });
  it("does nothing and does not audit when nothing changes", async () => {
    const r = await patch({ noSignalTimeoutSeconds: 60 });
    expect(r.statusCode).toBe(200);
    expect(repo.updateChannel).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
  it("400 with the field name for bad input, nothing saved", async () => {
    const r = await patch({ connectionConfig: { port: 99999 } });
    expect(r.statusCode).toBe(400);
    expect(r.json().field).toBe("connectionConfig.port");
    expect(repo.updateChannel).not.toHaveBeenCalled();
  });
  it("404 for an unknown channel, and for an unknown machine (foreign key)", async () => {
    repo.getChannel.mockResolvedValue(null);
    expect((await patch({ machineId: "m2" })).statusCode).toBe(404);
    repo.getChannel.mockResolvedValue(channel);
    repo.updateChannel.mockRejectedValue(Object.assign(new Error("fk"), { code: "23503" }));
    const r = await patch({ machineId: "ghost" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "unknown machine", field: "machineId" });
    expect(audit).not.toHaveBeenCalled();
  });
});
