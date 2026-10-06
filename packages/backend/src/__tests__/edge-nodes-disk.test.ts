import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query } }));

import { claimEdgeNode, listEdgeNodes, recordHeartbeat } from "../edge-nodes-repository.js";

const sqlOf = (call: unknown[]): string => String(call[0]).split(/\s+/).join(" ");
const GIB = 1024 ** 3;

describe("edge node disk", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("is stored when the agent claims the node with its disk", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "n1", current_session_id: null, last_heartbeat_at: null, settings: {} }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await claimEdgeNode("token", undefined, { usedBytes: 10 * GIB, availBytes: 20 * GIB });
    const write = query.mock.calls.find((c) => sqlOf(c).includes("disk_used_bytes"));
    expect(write).toBeDefined();
    expect(write![1]).toEqual(["n1", 10 * GIB, 20 * GIB]);
  });

  it("is left alone when an older agent (or a malformed report) sends no disk", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "n1", current_session_id: null, last_heartbeat_at: null, settings: {} }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await claimEdgeNode("token", undefined, { usedBytes: "lots" });
    expect(query.mock.calls.some((c) => sqlOf(c).includes("disk_used_bytes"))).toBe(false);
  });

  it("is updated by the heartbeat, and kept when the heartbeat has no disk", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "n1", current_session_id: "s1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "n1", current_session_id: "s1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await recordHeartbeat("token", "s1", undefined, { usedBytes: 5 * GIB, availBytes: 6 * GIB });
    await recordHeartbeat("token", "s1");
    expect(sqlOf(query.mock.calls[1]!)).toContain("disk_used_bytes = COALESCE($3::bigint, disk_used_bytes)");
    expect(query.mock.calls[1]![1]!.slice(2)).toEqual([5 * GIB, 6 * GIB]);
    expect(query.mock.calls[3]![1]!.slice(2)).toEqual([null, null]);
  });

  it("is listed with the percentage and the low flag (bigint arrives as a string)", async () => {
    const base = { name: "n", current_session_id: null, last_heartbeat_at: null, created_at: "2026-10-01T00:00:00.000Z", settings: {} };
    query
      .mockResolvedValueOnce({
        rows: [
          { ...base, id: "a", disk_used_bytes: String(10 * GIB), disk_avail_bytes: String(20 * GIB) },
          { ...base, id: "b", disk_used_bytes: String(90 * GIB), disk_avail_bytes: String(10 * GIB) },
          { ...base, id: "c", disk_used_bytes: null, disk_avail_bytes: null },
        ],
        rowCount: 3,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const nodes = await listEdgeNodes();
    expect(nodes.map((n) => [n.diskUsedPercent === null ? null : Math.round(n.diskUsedPercent!), n.diskLow])).toEqual([
      [33, false],
      [90, true],
      [null, false],
    ]);
  });
});
