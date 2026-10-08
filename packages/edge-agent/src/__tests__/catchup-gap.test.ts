import { describe, expect, it } from "vitest";
import { droppedGapOf, planCatchup } from "../catchup.js";

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const stored = (good: number, scrap: number, ageMs: number) => ({ good, scrap, seenAtMs: NOW - ageMs });

describe("droppedGapOf", () => {
  it("describes a gap that is too old", () => {
    const plan = planCatchup(stored(100, 5, 25 * MIN), { good: 220, scrap: 8 }, NOW, 10 * MIN);
    expect(droppedGapOf(plan)).toEqual({ reason: "too_old", gapSeconds: 1500, lostGood: 120, lostScrap: 3 });
  });
  it("has an unknown length when the clock was set back", () => {
    const plan = planCatchup(stored(100, 5, -5 * MIN), { good: 110, scrap: 5 }, NOW, 10 * MIN);
    expect(droppedGapOf(plan)).toEqual({ reason: "clock_back", gapSeconds: -300, lostGood: 10, lostScrap: 0 });
  });
  it("reports too_large and disabled", () => {
    expect(droppedGapOf(planCatchup(stored(0, 0, MIN), { good: 6000, scrap: 0 }, NOW, 10 * MIN))).toMatchObject({ reason: "too_large", lostGood: 6000 });
    expect(droppedGapOf(planCatchup(stored(0, 0, MIN), { good: 4, scrap: 1 }, NOW, 0))).toMatchObject({ reason: "disabled", lostGood: 4, lostScrap: 1 });
  });
  it("is null when everything was booked or nothing was lost", () => {
    expect(droppedGapOf(planCatchup(stored(100, 5, 2 * MIN), { good: 110, scrap: 5 }, NOW, 10 * MIN))).toBeNull(); // caught_up
    expect(droppedGapOf(planCatchup(stored(100, 5, 30 * MIN), { good: 100, scrap: 5 }, NOW, 10 * MIN))).toBeNull(); // no_gap
    expect(droppedGapOf(planCatchup(null, { good: 5, scrap: 0 }, NOW, 10 * MIN))).toBeNull(); // first_start
    expect(droppedGapOf(planCatchup(stored(100, 5, MIN), { good: 3, scrap: 0 }, NOW, 10 * MIN))).toBeNull(); // counter_reset
  });
});
