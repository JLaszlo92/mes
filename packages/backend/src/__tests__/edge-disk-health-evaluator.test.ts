import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, raise, resolve } = vi.hoisted(() => ({ query: vi.fn(), raise: vi.fn(), resolve: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query } }));
vi.mock("../alerts-repository.js", () => ({ raiseOrUpdateSystemAlert: raise, resolveSystemAlert: resolve }));

import { createEdgeDiskCheck } from "../edge-disk-health-evaluator.js";
import { DEFAULT_DISK_LIMITS } from "../disk-health.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const GIB = 1024 ** 3;
const row = (usedGiB: number, availGiB: number) => ({ name: "node-gate-sim", disk_used_bytes: String(usedGiB * GIB), disk_avail_bytes: String(availGiB * GIB) });

describe("createEdgeDiskCheck", () => {
  beforeEach(() => {
    query.mockReset();
    raise.mockReset();
    resolve.mockReset();
  });

  it("raises, stays raised in the hysteresis band, and resolves below it", async () => {
    const check = createEdgeDiskCheck(log, DEFAULT_DISK_LIMITS);

    query.mockResolvedValueOnce({ rows: [row(9, 1)], rowCount: 1 });
    raise.mockResolvedValueOnce(true);
    await check();
    expect(raise.mock.calls[0]![0]).toBe("edge_disk_space");
    expect(raise.mock.calls[0]![1]).toContain("edge node node-gate-sim is 90% used");
    expect(raise.mock.calls[0]![1]).toContain("edge agent from buffering");

    query.mockResolvedValueOnce({ rows: [row(82, 18)], rowCount: 1 });
    raise.mockResolvedValueOnce(false);
    await check();
    expect(raise).toHaveBeenCalledTimes(2);
    expect(resolve).not.toHaveBeenCalled();

    query.mockResolvedValueOnce({ rows: [row(10, 90)], rowCount: 1 });
    resolve.mockResolvedValueOnce(true);
    await check();
    expect(resolve).toHaveBeenCalledWith("edge_disk_space");
  });

  it("resolves when no online node reports a disk (offline or older agents are not selected)", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    resolve.mockResolvedValueOnce(false);
    await createEdgeDiskCheck(log, DEFAULT_DISK_LIMITS)();
    expect(raise).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith("edge_disk_space");
  });
});
