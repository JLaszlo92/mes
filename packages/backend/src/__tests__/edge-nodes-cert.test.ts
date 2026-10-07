import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query } }));

import { claimEdgeNode, listEdgeNodes, recordHeartbeat } from "../edge-nodes-repository.js";

const sqlOf = (call: unknown[]): string => String(call[0]).split(/\s+/).join(" ");
const DAY = 86_400_000;
const EXPIRES = Date.UTC(2027, 9, 2, 5, 54, 40);

describe("edge node client certificate", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("is stored when the agent claims the node with its certificate expiry", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "n1", current_session_id: null, last_heartbeat_at: null, settings: {} }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await claimEdgeNode("token", undefined, undefined, { expiresAtMs: EXPIRES });
    const write = query.mock.calls.find((c) => sqlOf(c).includes("client_cert_expires_at"));
    expect(write).toBeDefined();
    expect(sqlOf(write!)).toContain("IS DISTINCT FROM");
    expect(write![1]).toEqual(["n1", new Date(EXPIRES)]);
  });

  it("is left alone when an older agent (or a malformed report) sends none", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "n1", current_session_id: null, last_heartbeat_at: null, settings: {} }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await claimEdgeNode("token", undefined, undefined, { expiresAtMs: "soon" });
    expect(query.mock.calls.some((c) => sqlOf(c).includes("client_cert_expires_at"))).toBe(false);
  });

  it("is refreshed by the heartbeat only when it carries a certificate", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "n1", current_session_id: "s1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "n1", current_session_id: "s1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await recordHeartbeat("token", "s1", undefined, undefined, { expiresAtMs: EXPIRES });
    await recordHeartbeat("token", "s1");
    const writes = query.mock.calls.filter((c) => sqlOf(c).includes("client_cert_expires_at"));
    expect(writes).toHaveLength(1);
    expect(writes[0]![1]).toEqual(["n1", new Date(EXPIRES)]);
  });

  it("is listed with the days left and the expiring flag", async () => {
    const now = Date.now();
    const base = { name: "n", current_session_id: null, last_heartbeat_at: null, created_at: "2026-10-01T00:00:00.000Z", settings: {} };
    query
      .mockResolvedValueOnce({
        rows: [
          { ...base, id: "a", client_cert_expires_at: new Date(now + 300.5 * DAY) },
          { ...base, id: "b", client_cert_expires_at: new Date(now + 10.5 * DAY) },
          { ...base, id: "c", client_cert_expires_at: new Date(now - 2.5 * DAY) },
          { ...base, id: "d", client_cert_expires_at: null },
        ],
        rowCount: 4,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const nodes = await listEdgeNodes();
    expect(nodes.map((n) => [n.clientCertDaysLeft, n.clientCertExpiring])).toEqual([
      [300, false],
      [10, true],
      [-3, true],
      [null, false],
    ]);
    expect(nodes[3]!.clientCertExpiresAt).toBeNull();
    expect(typeof nodes[0]!.clientCertExpiresAt).toBe("string");
  });
});
