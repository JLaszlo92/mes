import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, raise, resolve } = vi.hoisted(() => ({ query: vi.fn(), raise: vi.fn(), resolve: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query } }));
vi.mock("../alerts-repository.js", () => ({ raiseOrUpdateSystemAlert: raise, resolveSystemAlert: resolve }));

import { createEdgeOfflineCheck } from "../edge-offline-health-evaluator.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const MIN = 60_000;
const node = (minutesAgo: number) => ({ name: "node-gate-sim", last_heartbeat_at: new Date(NOW - minutesAgo * MIN), last_seen_at: new Date(NOW - minutesAgo * MIN) });

describe("createEdgeOfflineCheck", () => {
  beforeEach(() => {
    query.mockReset();
    raise.mockReset();
    resolve.mockReset();
  });

  it("raises while a node is silent and resolves when it is back", async () => {
    const check = createEdgeOfflineCheck(log, 180, () => NOW, () => 10_000);

    query.mockResolvedValueOnce({ rows: [node(4)], rowCount: 1 });
    raise.mockResolvedValueOnce(true);
    await check();
    expect(raise.mock.calls[0]![0]).toBe("edge_node_offline");
    expect(raise.mock.calls[0]![1]).toContain("node-gate-sim (no heartbeat for 4 min)");

    query.mockResolvedValueOnce({ rows: [node(0.1)], rowCount: 1 });
    resolve.mockResolvedValueOnce(true);
    await check();
    expect(resolve).toHaveBeenCalledWith("edge_node_offline");
  });

  it("reads a cleanly stopped node from last_seen_at", async () => {
    query.mockResolvedValueOnce({ rows: [{ name: "n1", last_heartbeat_at: null, last_seen_at: new Date(NOW - 20 * MIN) }], rowCount: 1 });
    raise.mockResolvedValueOnce(true);
    await createEdgeOfflineCheck(log, 180, () => NOW, () => 10_000)();
    expect(raise.mock.calls[0]![1]).toContain("n1 (stopped 20 min ago)");
  });

  it("does not look at all during the grace period after the backend started", async () => {
    await createEdgeOfflineCheck(log, 180, () => NOW, () => 60)();
    expect(query).not.toHaveBeenCalled();
    expect(raise).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("stays quiet without any node and looks at offline ones too", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    resolve.mockResolvedValueOnce(false);
    await createEdgeOfflineCheck(log, 180, () => NOW, () => 10_000)();
    expect(raise).not.toHaveBeenCalled();
    const sql = String(query.mock.calls[0]![0]).split(/\s+/).join(" ");
    expect(sql).toContain("last_heartbeat_at IS NOT NULL OR last_seen_at IS NOT NULL");
  });
});
