import { describe, expect, it } from "vitest";
import { CLOCK_WARN_MS, clockOffsetMs, isClockSkewed, parseStoredOffset } from "../clock-offset.js";

describe("clockOffsetMs", () => {
  const now = 1_791_222_000_000;

  it("is the device clock minus the server clock", () => {
    expect(clockOffsetMs(now + 900_000, now)).toBe(900_000);
    expect(clockOffsetMs(now - 15_000, now)).toBe(-15_000);
    expect(clockOffsetMs(now, now)).toBe(0);
  });

  it("rounds to whole milliseconds", () => {
    expect(clockOffsetMs(now + 0.4, now)).toBe(0);
    expect(clockOffsetMs(now + 1.6, now)).toBe(2);
  });

  it("is unknown when the agent sent nothing usable", () => {
    expect(clockOffsetMs(undefined, now)).toBeNull();
    expect(clockOffsetMs(null, now)).toBeNull();
    expect(clockOffsetMs("1791222000000", now)).toBeNull();
    expect(clockOffsetMs(Number.NaN, now)).toBeNull();
    expect(clockOffsetMs(Number.POSITIVE_INFINITY, now)).toBeNull();
  });

  it("reports a clock stuck in 1970 instead of hiding it", () => {
    expect(clockOffsetMs(0, now)).toBe(-now);
  });
});

describe("isClockSkewed", () => {
  it("warns above the limit in both directions, never for unknown", () => {
    expect(CLOCK_WARN_MS).toBe(30_000);
    expect(isClockSkewed(null)).toBe(false);
    expect(isClockSkewed(0)).toBe(false);
    expect(isClockSkewed(30_000)).toBe(false);
    expect(isClockSkewed(30_001)).toBe(true);
    expect(isClockSkewed(-30_001)).toBe(true);
    expect(isClockSkewed(5_000, 1_000)).toBe(true);
  });
});

describe("parseStoredOffset", () => {
  it("reads numbers and the strings pg returns for bigint", () => {
    expect(parseStoredOffset(900_000)).toBe(900_000);
    expect(parseStoredOffset("900000")).toBe(900_000);
    expect(parseStoredOffset("-1791222000000")).toBe(-1_791_222_000_000);
  });

  it("is unknown for anything else", () => {
    expect(parseStoredOffset(null)).toBeNull();
    expect(parseStoredOffset(undefined)).toBeNull();
    expect(parseStoredOffset("")).toBeNull();
    expect(parseStoredOffset("abc")).toBeNull();
    expect(parseStoredOffset("1.5")).toBeNull();
    expect(parseStoredOffset(1.5)).toBeNull();
  });
});
