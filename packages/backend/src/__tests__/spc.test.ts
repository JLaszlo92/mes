import { describe, expect, it } from "vitest";
import { capability, grade, imrStats, movingRanges, signals } from "../spc.js";

describe("imrStats", () => {
  it("mean, moving range, control limits", () => {
    const s = imrStats([10, 12, 11, 13, 12])!;
    expect(s.n).toBe(5);
    expect(s.mean).toBeCloseTo(11.6);
    expect(s.mrBar).toBeCloseTo((2 + 1 + 2 + 1) / 4);
    expect(s.sigmaWithin).toBeCloseTo(1.5 / 1.128);
    expect(s.ucl).toBeCloseTo(11.6 + 2.66 * 1.5, 2);
    expect(s.lcl).toBeCloseTo(11.6 - 2.66 * 1.5, 2);
    expect(s.mrUcl).toBeCloseTo(3.267 * 1.5);
    expect(s.sigmaOverall).toBeCloseTo(Math.sqrt(((10 - 11.6) ** 2 + 0.4 ** 2 + 0.6 ** 2 + 1.4 ** 2 + 0.4 ** 2) / 4));
  });
  it("one value has no spread, none has nothing", () => {
    expect(imrStats([5])).toMatchObject({ n: 1, mean: 5, sigmaWithin: null, ucl: null });
    expect(imrStats([])).toBeNull();
  });
  it("moving ranges", () => {
    expect(movingRanges([1, 4, 2])).toEqual([null, 3, 2]);
  });
});

describe("capability", () => {
  const stats = { mean: 10, sigmaWithin: 0.01, sigmaOverall: 0.02 };
  it("two-sided", () => {
    const c = capability(stats, 9.95, 10.05);
    expect(c.cp).toBeCloseTo(0.1 / 0.06);
    expect(c.cpk).toBeCloseTo(0.05 / 0.03);
    expect(c.pp).toBeCloseTo(0.1 / 0.12);
    expect(c.ppk).toBeCloseTo(0.05 / 0.06);
  });
  it("off-centre takes the nearer limit", () => {
    expect(capability({ ...stats, mean: 10.03 }, 9.95, 10.05).cpk).toBeCloseTo(0.02 / 0.03);
  });
  it("one-sided: no Cp, Cpk to that side", () => {
    const c = capability({ mean: 0.8, sigmaWithin: 0.1, sigmaOverall: 0.1 }, null, 1.6);
    expect(c.cp).toBeNull();
    expect(c.cpk).toBeCloseTo(0.8 / 0.3);
  });
  it("no spread: nothing", () => {
    expect(capability({ mean: 1, sigmaWithin: 0, sigmaOverall: null }, 0, 2)).toEqual({ cp: null, cpk: null, pp: null, ppk: null });
  });
  it("grades", () => {
    expect(grade(1.5)).toBe("capable");
    expect(grade(1.2)).toBe("marginal");
    expect(grade(0.8)).toBe("not_capable");
    expect(grade(null)).toBe("unknown");
  });
});

describe("signals", () => {
  const stats = { mean: 0, ucl: 3, lcl: -3 };
  it("beyond the control limits", () => {
    expect(signals([0, 3.5, -1, -4], stats)).toEqual([[], ["beyond"], [], ["beyond"]]);
  });
  it("seven on one side is a run, six is not", () => {
    expect(signals([1, 1, 1, 1, 1, 1, -1], stats).flat()).toEqual([]);
    const s = signals([-1, 1, 2, 1, 2, 1, 2, 1, -1], stats);
    expect(s.map((x) => x.includes("run"))).toEqual([false, true, true, true, true, true, true, true, false]);
  });
  it("six rising is a trend", () => {
    const s = signals([0.5, -2, -1, 0, 1, 2, 2.5, 1], stats);
    expect(s.map((x) => x.includes("trend"))).toEqual([false, true, true, true, true, true, true, false]);
  });
  it("no limits, no signals", () => {
    expect(signals([1, 2], null)).toEqual([[], []]);
  });
});
