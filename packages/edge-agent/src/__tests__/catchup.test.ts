import { describe, expect, it } from "vitest";
import { MAX_CATCHUP_PARTS, planCatchup } from "../catchup.js";

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const stored = (good: number, scrap: number, agoMs: number) => ({ good, scrap, seenAtMs: NOW - agoMs });

describe("planCatchup", () => {
  it("starts from the current values when nothing is known", () => {
    const p = planCatchup(null, { good: 500, scrap: 3 }, NOW, 10 * MIN);
    expect(p).toMatchObject({ note: "first_start", emit: { good: 0, scrap: 0 } });
  });

  it("books the missed parts for a short gap", () => {
    const p = planCatchup(stored(1000, 10, 70_000), { good: 1035, scrap: 11 }, NOW, 10 * MIN);
    expect(p.note).toBe("caught_up");
    expect(p.emit).toEqual({ good: 35, scrap: 1 });
    expect(p.lost).toEqual({ good: 0, scrap: 0 });
  });

  it("books the gap exactly at the limit, drops it just above", () => {
    expect(planCatchup(stored(0, 0, 10 * MIN), { good: 5, scrap: 0 }, NOW, 10 * MIN).note).toBe("caught_up");
    const p = planCatchup(stored(0, 0, 10 * MIN + 1), { good: 5, scrap: 0 }, NOW, 10 * MIN);
    expect(p).toMatchObject({ note: "too_old", emit: { good: 0, scrap: 0 }, lost: { good: 5, scrap: 0 } });
  });

  it("reports no gap when the counters did not move, however old the state is", () => {
    expect(planCatchup(stored(7, 1, 3 * 60 * MIN), { good: 7, scrap: 1 }, NOW, 10 * MIN).note).toBe("no_gap");
  });

  it("treats a counter that went backwards as a PLC reset", () => {
    const p = planCatchup(stored(1000, 10, 1000), { good: 3, scrap: 0 }, NOW, 10 * MIN);
    expect(p).toMatchObject({ note: "counter_reset", emit: { good: 0, scrap: 0 }, lost: { good: 0, scrap: 0 } });
  });

  it("does not book anything when catch-up is switched off, but reports the loss", () => {
    const p = planCatchup(stored(10, 0, 1000), { good: 20, scrap: 0 }, NOW, 0);
    expect(p).toMatchObject({ note: "disabled", emit: { good: 0, scrap: 0 }, lost: { good: 10, scrap: 0 } });
  });

  it("does not trust a state from the future (clock set back)", () => {
    const p = planCatchup(stored(10, 0, -5000), { good: 12, scrap: 0 }, NOW, 10 * MIN);
    expect(p.note).toBe("too_old");
  });

  it("refuses an implausibly large jump", () => {
    const p = planCatchup(stored(0, 0, 1000), { good: MAX_CATCHUP_PARTS + 1, scrap: 0 }, NOW, 10 * MIN);
    expect(p).toMatchObject({ note: "too_large", emit: { good: 0, scrap: 0 } });
    expect(planCatchup(stored(0, 0, 1000), { good: MAX_CATCHUP_PARTS, scrap: 0 }, NOW, 10 * MIN).note).toBe("caught_up");
  });
});
