import { describe, expect, it } from "vitest";
import { DEFAULT_DISK_LIMITS, assessDisks, usedPercent, type DiskVolume } from "../disk-health.js";

const GIB = 1024 ** 3;
const vol = (label: string, usedGiB: number, availGiB: number): DiskVolume => ({ label, usedBytes: usedGiB * GIB, availBytes: availGiB * GIB });

describe("usedPercent", () => {
  it("is used / (used + available), like df", () => {
    expect(usedPercent(vol("/", 9.7, 20))).toBeCloseTo(32.65, 1);
    expect(usedPercent(vol("/", 0, 0))).toBe(0);
  });
});

describe("assessDisks", () => {
  it("is healthy for no volumes and for a disk with room", () => {
    expect(assessDisks([], false)).toEqual({ healthy: true });
    expect(assessDisks([vol("/", 9.7, 20)], false)).toEqual({ healthy: true });
  });

  it("alerts at the raise percentage and names the volume", () => {
    expect(assessDisks([vol("/", 84, 16)], false).healthy).toBe(true);
    const r = assessDisks([vol("/", 85, 15)], false);
    expect(r.healthy).toBe(false);
    if (!r.healthy) expect(r.message).toContain("/ is 85% used (15.0 GiB free of 100.0 GiB)");
  });

  it("alerts when less than the minimum is free even on a mostly empty disk", () => {
    const r = assessDisks([vol("/", 1, 1.9)], false);
    expect(r.healthy).toBe(false);
    expect(assessDisks([vol("/", 1, 2.1)], false).healthy).toBe(true);
  });

  it("keeps alerting between the clear and the raise percentage, and clears below it", () => {
    expect(assessDisks([vol("/", 82, 18)], false).healthy).toBe(true);
    expect(assessDisks([vol("/", 82, 18)], true).healthy).toBe(false);
    expect(assessDisks([vol("/", 79, 21)], true).healthy).toBe(true);
  });

  it("needs a margin above the minimum free space to clear", () => {
    expect(assessDisks([vol("/", 1, 2.2)], true).healthy).toBe(false); // < 2 * 1.25 GiB
    expect(assessDisks([vol("/", 1, 2.6)], true).healthy).toBe(true);
  });

  it("lists every problem volume, fullest first, and ignores a volume without size", () => {
    const r = assessDisks([vol("/a", 86, 14), vol("/b", 95, 5), vol("/ok", 10, 90), vol("/empty", 0, 0)], false);
    expect(r.healthy).toBe(false);
    if (!r.healthy) {
      expect(r.message.indexOf("/b")).toBeLessThan(r.message.indexOf("/a"));
      expect(r.message).not.toContain("/ok");
      expect(r.message).not.toContain("/empty");
    }
  });

  it("uses the limits it is given", () => {
    const strict = { ...DEFAULT_DISK_LIMITS, raisePercent: 30, clearPercent: 25 };
    expect(assessDisks([vol("/", 33, 67)], false, strict).healthy).toBe(false);
  });
});
