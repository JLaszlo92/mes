import { beforeEach, describe, expect, it, vi } from "vitest";

const { raise, resolve, stat, statfs } = vi.hoisted(() => ({ raise: vi.fn(), resolve: vi.fn(), stat: vi.fn(), statfs: vi.fn() }));
vi.mock("../alerts-repository.js", () => ({ raiseOrUpdateSystemAlert: raise, resolveSystemAlert: resolve }));
vi.mock("node:fs/promises", () => ({ stat, statfs }));

import { createDiskCheck, limitsFromEnv, pathsFromEnv, readVolumes } from "../disk-health-evaluator.js";
import { DEFAULT_DISK_LIMITS } from "../disk-health.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
/** 100 blocks of 1 GiB: `used` of them used, the rest available. */
const disk = (used: number) => ({ bsize: 1024 ** 3, blocks: 100, bfree: 100 - used, bavail: 100 - used });

describe("readVolumes", () => {
  beforeEach(() => {
    stat.mockReset();
    statfs.mockReset();
  });

  it("reads used and available bytes, once per device, and skips a missing path", async () => {
    stat.mockImplementation(async (p: string) => {
      if (p === "/gone") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { dev: 7 };
    });
    statfs.mockResolvedValue(disk(33));
    const v = await readVolumes(["/", "/var/lib/postgresql", "/gone"]);
    expect(v).toEqual([{ label: "/", usedBytes: 33 * 1024 ** 3, availBytes: 67 * 1024 ** 3 }]);
    expect(statfs).toHaveBeenCalledTimes(1);
  });
});

describe("createDiskCheck", () => {
  beforeEach(() => {
    stat.mockReset().mockResolvedValue({ dev: 1 });
    statfs.mockReset();
    raise.mockReset();
    resolve.mockReset();
  });

  it("raises when the disk is nearly full, keeps it in the hysteresis band, resolves below it", async () => {
    const check = createDiskCheck(log, ["/"], DEFAULT_DISK_LIMITS);

    statfs.mockResolvedValue(disk(90));
    raise.mockResolvedValueOnce(true);
    await check();
    expect(raise).toHaveBeenCalledTimes(1);
    expect(raise.mock.calls[0]![0]).toBe("disk_space");
    expect(raise.mock.calls[0]![1]).toContain("/ is 90% used");

    statfs.mockResolvedValue(disk(82)); // between 80 and 85: still alerting
    raise.mockResolvedValueOnce(false);
    await check();
    expect(raise).toHaveBeenCalledTimes(2);
    expect(resolve).not.toHaveBeenCalled();

    statfs.mockResolvedValue(disk(70));
    resolve.mockResolvedValueOnce(true);
    await check();
    expect(resolve).toHaveBeenCalledWith("disk_space");
  });

  it("does not raise for a disk with room", async () => {
    statfs.mockResolvedValue(disk(33));
    resolve.mockResolvedValueOnce(false);
    await createDiskCheck(log, ["/"], DEFAULT_DISK_LIMITS)();
    expect(raise).not.toHaveBeenCalled();
  });
});

describe("settings from the environment", () => {
  it("uses the defaults, and reads overrides", () => {
    delete process.env.DISK_WARN_PERCENT;
    delete process.env.DISK_MIN_FREE_GIB;
    delete process.env.DISK_CHECK_PATHS;
    expect(limitsFromEnv()).toEqual(DEFAULT_DISK_LIMITS);
    expect(pathsFromEnv()).toEqual(["/", "/var/lib/postgresql"]);

    process.env.DISK_WARN_PERCENT = "30";
    process.env.DISK_MIN_FREE_GIB = "5";
    process.env.DISK_CHECK_PATHS = " /data , /var ";
    expect(limitsFromEnv()).toEqual({ raisePercent: 30, clearPercent: 25, minFreeBytes: 5 * 1024 ** 3 });
    expect(pathsFromEnv()).toEqual(["/data", "/var"]);

    process.env.DISK_WARN_PERCENT = "nonsense";
    expect(limitsFromEnv().raisePercent).toBe(85);
    delete process.env.DISK_WARN_PERCENT;
    delete process.env.DISK_MIN_FREE_GIB;
    delete process.env.DISK_CHECK_PATHS;
  });
});
