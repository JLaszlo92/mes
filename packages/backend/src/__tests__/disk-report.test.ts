import { describe, expect, it } from "vitest";
import { diskView, parseDiskReport } from "../disk-report.js";

const GIB = 1024 ** 3;

describe("parseDiskReport", () => {
  it("accepts two byte counts and rounds them", () => {
    expect(parseDiskReport({ usedBytes: 10 * GIB, availBytes: 20.4 })).toEqual({ usedBytes: 10 * GIB, availBytes: 20 });
  });

  it("rejects anything else (older agents send nothing)", () => {
    for (const bad of [undefined, null, 5, "x", {}, { usedBytes: 1 }, { usedBytes: -1, availBytes: 1 }, { usedBytes: NaN, availBytes: 1 }, { usedBytes: "1", availBytes: 1 }, { usedBytes: 1e30, availBytes: 1 }]) {
      expect(parseDiskReport(bad)).toBeNull();
    }
  });
});

describe("diskView", () => {
  it("is empty when nothing is stored", () => {
    expect(diskView(null, null)).toEqual({ diskUsedBytes: null, diskAvailBytes: null, diskUsedPercent: null, diskLow: false });
    expect(diskView(undefined, "5")).toMatchObject({ diskUsedBytes: null, diskLow: false });
  });

  it("reads bigint strings and flags a nearly full disk", () => {
    const ok = diskView(String(10 * GIB), String(20 * GIB));
    expect(ok.diskUsedPercent).toBeCloseTo(33.3, 1);
    expect(ok.diskLow).toBe(false);
    const full = diskView(String(90 * GIB), String(10 * GIB));
    expect(full).toMatchObject({ diskUsedBytes: 90 * GIB, diskAvailBytes: 10 * GIB, diskLow: true });
  });
});
