import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query } }));

import { claimEdgeNode, listEdgeNodes, recordHeartbeat } from "../edge-nodes-repository.js";

const sqlOf = (call: unknown[]): string => String(call[0]).split(/\s+/).join(" ");

describe("edge node clock offset", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("is stored when the agent claims the node with its clock", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "n1", current_session_id: null, last_heartbeat_at: null, settings: {} }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await claimEdgeNode("token", Date.now() + 900_000);
    const write = query.mock.calls.find((c) => sqlOf(c).includes("clock_offset_ms"));
    expect(write).toBeDefined();
    expect(write![1]![0]).toBe("n1");
    expect(Math.abs((write![1]![1] as number) - 900_000)).toBeLessThan(2_000);
  });

  it("is left alone when an older agent sends no clock", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "n1", current_session_id: null, last_heartbeat_at: null, settings: {} }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await claimEdgeNode("token");
    expect(query.mock.calls.some((c) => sqlOf(c).includes("clock_offset_ms"))).toBe(false);
  });

  it("is updated by the heartbeat, and kept when the heartbeat has no clock", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "n1", current_session_id: "s1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "n1", current_session_id: "s1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await recordHeartbeat("token", "s1", Date.now() - 120_000);
    await recordHeartbeat("token", "s1");
    const sql = sqlOf(query.mock.calls[1]!);
    expect(sql).toContain("clock_offset_ms = COALESCE($2::bigint, clock_offset_ms)");
    expect(Math.abs((query.mock.calls[1]![1]![1] as number) + 120_000)).toBeLessThan(2_000);
    expect(query.mock.calls[3]![1]![1]).toBeNull();
  });

  it("is listed with the skew flag (bigint arrives as a string)", async () => {
    const base = { name: "n", current_session_id: null, last_heartbeat_at: null, created_at: "2026-10-01T00:00:00.000Z", settings: {} };
    query
      .mockResolvedValueOnce({
        rows: [
          { ...base, id: "a", clock_offset_ms: "900000" },
          { ...base, id: "b", clock_offset_ms: "-4000" },
          { ...base, id: "c", clock_offset_ms: null },
        ],
        rowCount: 3,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const nodes = await listEdgeNodes();
    expect(nodes.map((n) => [n.clockOffsetMs, n.clockSkewed])).toEqual([
      [900_000, true],
      [-4_000, false],
      [null, false],
    ]);
  });
});
