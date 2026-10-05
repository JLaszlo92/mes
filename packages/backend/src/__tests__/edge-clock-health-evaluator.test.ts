import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, raise, resolve } = vi.hoisted(() => ({ query: vi.fn(), raise: vi.fn(), resolve: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query } }));
vi.mock("../alerts-repository.js", () => ({ raiseOrUpdateSystemAlert: raise, resolveSystemAlert: resolve }));

import { ONLINE_WITHIN_SECONDS, checkEdgeClocks } from "../edge-clock-health-evaluator.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe("checkEdgeClocks", () => {
  beforeEach(() => {
    query.mockReset();
    raise.mockReset();
    resolve.mockReset();
  });

  it("raises the system alert for an online node with a skewed clock", async () => {
    query.mockResolvedValueOnce({ rows: [{ name: "node-gate-sim", online: true, clock_offset_ms: "125000" }], rowCount: 1 });
    raise.mockResolvedValueOnce(true);
    await checkEdgeClocks(log);
    expect(raise).toHaveBeenCalledTimes(1);
    expect(raise.mock.calls[0]![0]).toBe("edge_clock_skew");
    expect(raise.mock.calls[0]![1]).toContain("node-gate-sim (2 min ahead)");
    expect(resolve).not.toHaveBeenCalled();
    expect(query.mock.calls[0]![1]).toEqual([ONLINE_WITHIN_SECONDS]);
  });

  it("resolves the alert when every online node is within the limit", async () => {
    query.mockResolvedValueOnce({ rows: [{ name: "node-gate-sim", online: true, clock_offset_ms: "-7" }], rowCount: 1 });
    resolve.mockResolvedValueOnce(true);
    await checkEdgeClocks(log);
    expect(resolve).toHaveBeenCalledWith("edge_clock_skew");
    expect(raise).not.toHaveBeenCalled();
  });

  it("does not alert for a skewed node that is offline, nor for an unknown offset", async () => {
    query.mockResolvedValueOnce({
      rows: [
        { name: "off", online: false, clock_offset_ms: "900000" },
        { name: "old-agent", online: true, clock_offset_ms: null },
      ],
      rowCount: 2,
    });
    resolve.mockResolvedValueOnce(false);
    await checkEdgeClocks(log);
    expect(raise).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith("edge_clock_skew");
  });
});
