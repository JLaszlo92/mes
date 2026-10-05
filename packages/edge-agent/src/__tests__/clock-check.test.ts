import { describe, expect, it } from "vitest";
import { CLOCK_WARN_MS, clockAheadMs, clockSkewWarning } from "../clock-check.js";

describe("clockAheadMs", () => {
  it("compares the middle of the request with the server time", () => {
    expect(clockAheadMs(10_000, 10_200, 10_100)).toBe(0);
    expect(clockAheadMs(910_000, 910_200, 10_100)).toBe(900_000);
    expect(clockAheadMs(10_000, 10_200, 70_100)).toBe(-60_000);
  });
});

describe("clockSkewWarning", () => {
  it("is silent for a good, borderline or unknown clock", () => {
    expect(CLOCK_WARN_MS).toBe(30_000);
    expect(clockSkewWarning(null)).toBeNull();
    expect(clockSkewWarning(0)).toBeNull();
    expect(clockSkewWarning(30_000)).toBeNull();
    expect(clockSkewWarning(-30_000)).toBeNull();
  });

  it("names the size and direction of a skew", () => {
    expect(clockSkewWarning(900_000)).toContain("900 s ahead of the server's");
    expect(clockSkewWarning(-60_000)).toContain("60 s behind the server's");
    expect(clockSkewWarning(31_000)).toContain("NTP");
  });
});
