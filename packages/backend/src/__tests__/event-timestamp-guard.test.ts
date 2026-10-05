import { describe, expect, it } from "vitest";
import { FUTURE_TOLERANCE_MS, guardEventTimestamp } from "../event-timestamp-guard.js";

const NOW = Date.parse("2026-10-05T19:00:00.000Z");

describe("guardEventTimestamp", () => {
  it("leaves past, current and slightly-future timestamps alone", () => {
    expect(guardEventTimestamp("2026-10-05T18:00:00.000Z", NOW)).toEqual({ corrected: false });
    expect(guardEventTimestamp("2026-10-05T19:00:00.000Z", NOW)).toEqual({ corrected: false });
    expect(guardEventTimestamp(new Date(NOW + FUTURE_TOLERANCE_MS).toISOString(), NOW)).toEqual({ corrected: false });
  });

  it("leaves a timestamp far in the past alone (not this guard's job)", () => {
    expect(guardEventTimestamp("1970-01-01T00:00:10.000Z", NOW)).toEqual({ corrected: false });
  });

  it("replaces a future timestamp with the receive time and keeps the original", () => {
    const g = guardEventTimestamp("2026-10-05T19:02:00.000Z", NOW);
    expect(g).toEqual({
      corrected: true,
      timestamp: "2026-10-05T19:00:00.000Z",
      info: { originalTimestamp: "2026-10-05T19:02:00.000Z", aheadMs: 120_000, reason: "future" },
    });
  });

  it("catches a timestamp just over the tolerance, and accepts Date and number inputs", () => {
    expect(guardEventTimestamp(new Date(NOW + FUTURE_TOLERANCE_MS + 1), NOW).corrected).toBe(true);
    expect(guardEventTimestamp(NOW + 3_600_000, NOW).corrected).toBe(true);
  });

  it("does not touch unparsable timestamps", () => {
    expect(guardEventTimestamp("not a date", NOW)).toEqual({ corrected: false });
    expect(guardEventTimestamp(undefined, NOW)).toEqual({ corrected: false });
    expect(guardEventTimestamp(null, NOW)).toEqual({ corrected: false });
  });
});
