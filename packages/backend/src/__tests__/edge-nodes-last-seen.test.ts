import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query } }));

import { claimEdgeNode, listEdgeNodes, recordHeartbeat, releaseSession } from "../edge-nodes-repository.js";

const sqlOf = (call: unknown[]): string => String(call[0]).split(/\s+/).join(" ");

describe("edge node last_seen_at", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("is set when the node is claimed", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "n1", current_session_id: null, last_heartbeat_at: null, settings: {} }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await claimEdgeNode("token");
    expect(sqlOf(query.mock.calls[1]!)).toContain("last_seen_at = now()");
  });

  it("is set on every heartbeat", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "n1", current_session_id: "s1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await recordHeartbeat("token", "s1");
    expect(sqlOf(query.mock.calls[1]!)).toContain("last_seen_at = now()");
  });

  it("is kept (set to now) when the agent releases the lease, while the heartbeat is cleared", async () => {
    query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 }).mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await expect(releaseSession("token", "s1")).resolves.toBe("released");
    const sql = sqlOf(query.mock.calls[1]!);
    expect(sql).toContain("last_heartbeat_at = NULL");
    expect(sql).toContain("last_seen_at = now()");
  });

  it("is listed for a node that is offline after a clean stop", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "n1",
            name: "node-gate-sim",
            current_session_id: null,
            last_heartbeat_at: null,
            last_seen_at: "2026-10-05T17:54:31.000Z",
            created_at: "2026-10-01T00:00:00.000Z",
            settings: {},
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const nodes = await listEdgeNodes();
    expect(nodes[0]?.isOnline).toBe(false);
    expect(nodes[0]?.lastHeartbeatAt).toBeNull();
    expect(nodes[0]?.lastSeenAt).toBe("2026-10-05T17:54:31.000Z");
  });
});
