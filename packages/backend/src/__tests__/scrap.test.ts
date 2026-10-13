import { describe, expect, it } from "vitest";
import { reasonsForMachine } from "../scrap-repository.js";
import { goodCountSql, partsCountSql } from "../count-sql.js";

const r = (id: string, machineId: string | null, code: string, isActive = true) => ({ id, machineId, code, name: code, isActive });

describe("reasonsForMachine", () => {
  it("own reasons first, then the global ones not overridden by code; inactive ones left out", () => {
    const all = [r("g1", null, "BURR"), r("g2", null, "DIM"), r("g3", null, "OLD", false), r("m1", "p1", "DIM"), r("m2", "p1", "TOOL"), r("x", "p2", "OTHER")];
    expect(reasonsForMachine(all, "p1").map((x) => x.id)).toEqual(["m1", "m2", "g1"]);
    expect(reasonsForMachine(all, "p9").map((x) => x.id)).toEqual(["g1", "g2"]);
  });
});

describe("count SQL", () => {
  it("takes reclassified scrap off the good count and does not count it as a part", () => {
    expect(goodCountSql("e")).toContain("e.payload->>'reclassified' = 'true'");
    expect(goodCountSql()).toMatch(/^\(COUNT\(\*\) FILTER \(WHERE payload->>'result' = 'good'\) - /);
    expect(partsCountSql()).toContain("<> 'true'");
  });
});
