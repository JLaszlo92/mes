import { describe, expect, it } from "vitest";
import { shapeRelated } from "../machine-related.js";

describe("shapeRelated", () => {
  it("turns pg count strings into numbers", () => {
    expect(
      shapeRelated(
        { fc_active: "3", fc_total: "4", ar_active: "2", ar_total: "2", ar_global_active: "1", pm_active: "0", pm_total: "1" },
        [{ id: "t1", name: "Line 1 terminal" }],
      ),
    ).toEqual({
      faultCodes: { active: 3, total: 4 },
      alertRules: { active: 2, total: 2, globalActive: 1 },
      preventiveSchedules: { active: 0, total: 1 },
      terminals: [{ id: "t1", name: "Line 1 terminal" }],
    });
  });
  it("treats missing or garbage values as 0", () => {
    const r = shapeRelated({ fc_active: null, fc_total: "x" }, []);
    expect(r.faultCodes).toEqual({ active: 0, total: 0 });
    expect(r.alertRules).toEqual({ active: 0, total: 0, globalActive: 0 });
    expect(r.terminals).toEqual([]);
  });
});
