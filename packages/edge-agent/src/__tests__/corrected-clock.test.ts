import { describe, expect, it } from "vitest";
import {
  CorrectedClock,
  clockCorrectionNotice,
  correctionFromAhead,
  measureAhead,
  shouldRestartChannels,
} from "../corrected-clock.js";

describe("correctionFromAhead", () => {
  it("returns the amount to add: a clock behind gets a positive correction", () => {
    expect(correctionFromAhead(-300_000)).toBe(300_000);
    expect(correctionFromAhead(120_000)).toBe(-120_000);
  });
  it("leaves small offsets alone", () => {
    expect(correctionFromAhead(0)).toBe(0);
    expect(correctionFromAhead(1_999)).toBe(0);
    expect(correctionFromAhead(-1_999)).toBe(0);
    expect(correctionFromAhead(2_000)).toBe(-2_000);
  });
  it("has no opinion without a usable measurement", () => {
    expect(correctionFromAhead(null)).toBeNull();
    expect(correctionFromAhead(Number.NaN)).toBeNull();
    expect(correctionFromAhead(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("measureAhead", () => {
  it("compares the middle of the request with the server time", () => {
    expect(measureAhead(1_000, 1_100, 1_050)).toBe(0);
    expect(measureAhead(301_000, 301_100, 1_050)).toBe(300_000);
    expect(measureAhead(1_000, 1_100, 301_050)).toBe(-300_000);
  });
  it("refuses a slow round trip and a missing or odd server time", () => {
    expect(measureAhead(0, 5_001, 2_500)).toBeNull();
    expect(measureAhead(0, 5_000, 2_500)).toBe(0);
    expect(measureAhead(10, 5, 7)).toBeNull();
    expect(measureAhead(0, 100, undefined)).toBeNull();
    expect(measureAhead(0, 100, "50")).toBeNull();
    expect(measureAhead(0, 100, Number.NaN)).toBeNull();
  });
});

describe("CorrectedClock", () => {
  const raw = (t: number) => () => t;

  it("is the raw clock until a measurement arrives", () => {
    const clock = new CorrectedClock(raw(1_000_000));
    expect(clock.offset).toBe(0);
    expect(clock.now()).toBe(1_000_000);
  });

  it("shifts now() and the ISO string by the correction", () => {
    const clock = new CorrectedClock(raw(Date.UTC(2026, 9, 8, 5, 41, 0)));
    expect(clock.update(-300_000)).toEqual({ changed: true, previous: 0, current: 300_000 });
    expect(clock.nowIso()).toBe("2026-10-08T05:46:00.000Z");
    expect(clock.update(120_000).current).toBe(-120_000);
    expect(clock.nowIso()).toBe("2026-10-08T05:39:00.000Z");
  });

  it("ignores the jitter of repeated measurements", () => {
    const clock = new CorrectedClock(raw(0));
    clock.update(-300_000);
    expect(clock.update(-300_126)).toEqual({ changed: false, previous: 300_000, current: 300_000 });
    expect(clock.update(-299_700).changed).toBe(false);
    expect(clock.offset).toBe(300_000);
    expect(clock.update(-300_600).current).toBe(300_600);
  });

  it("keeps the correction when there is no measurement", () => {
    const clock = new CorrectedClock(raw(0));
    clock.update(-60_000);
    expect(clock.update(null)).toEqual({ changed: false, previous: 60_000, current: 60_000 });
  });

  it("drops the correction when the device clock is fixed", () => {
    const clock = new CorrectedClock(raw(0));
    clock.update(-60_000);
    expect(clock.update(300)).toEqual({ changed: true, previous: 60_000, current: 0 });
    expect(clock.offset).toBe(0);
  });

  it("switches on a small correction even though it is below the jitter limit", () => {
    const clock = new CorrectedClock(raw(0));
    expect(clock.update(-2_100)).toEqual({ changed: true, previous: 0, current: 2_100 });
  });
});

describe("shouldRestartChannels", () => {
  it("restarts only when the correction moved more than 5 s", () => {
    expect(shouldRestartChannels(0, 5_000, null, 0)).toBe(false);
    expect(shouldRestartChannels(0, 5_001, null, 0)).toBe(true);
    expect(shouldRestartChannels(300_000, 0, null, 0)).toBe(true);
    expect(shouldRestartChannels(300_000, 300_400, null, 0)).toBe(false);
  });
  it("at most once per minute", () => {
    expect(shouldRestartChannels(0, 300_000, 1_000, 60_999)).toBe(false);
    expect(shouldRestartChannels(0, 300_000, 1_000, 61_000)).toBe(true);
  });
});

describe("clockCorrectionNotice", () => {
  it("names the direction, says that timestamps are corrected and still asks for NTP", () => {
    const behind = clockCorrectionNotice(-300_051);
    expect(behind).toContain("300 s behind");
    expect(behind).toContain("corrected");
    expect(behind).toContain("NTP");
    expect(clockCorrectionNotice(120_000)).toContain("120 s ahead of");
  });
});
