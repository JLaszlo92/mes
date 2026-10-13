import { describe, expect, it } from "vitest";
import { closedTotals, reportOutcome, type WorkOrderRun } from "../work-order-runs.js";
import { BULK_ELIGIBLE, parseWorkOrderPatch, WORK_ORDER_STATUSES } from "../work-order-input.js";

const run = (over: Partial<WorkOrderRun>): WorkOrderRun => ({
  id: "r",
  workOrderId: "wo",
  machineId: "m1",
  machineName: "M1",
  startedAt: "2026-10-13T08:00:00.000Z",
  startedByName: null,
  endedAt: null,
  endReason: null,
  countedGood: null,
  countedScrap: null,
  reportedGood: null,
  reportedScrap: null,
  scrapBreakdown: [],
  reportedManually: false,
  endedByName: null,
  terminalName: null,
  ...over,
});

describe("reportOutcome", () => {
  it("completes when the good parts reach the quantity with the earlier runs", () => {
    expect(reportOutcome({ previousGood: 60, good: 40, quantity: 100, pause: false })).toBe("completed");
    expect(reportOutcome({ previousGood: 0, good: 120, quantity: 100, pause: false })).toBe("completed");
  });
  it("pauses when fewer good parts are reported than planned", () => {
    expect(reportOutcome({ previousGood: 60, good: 39, quantity: 100, pause: false })).toBe("paused");
    expect(reportOutcome({ previousGood: 0, good: 0, quantity: 1, pause: false })).toBe("paused");
  });
  it("pauses when asked, even with all parts made", () => {
    expect(reportOutcome({ previousGood: 0, good: 100, quantity: 100, pause: true })).toBe("paused");
  });
  it("completes a report without a good count (older screens)", () => {
    expect(reportOutcome({ previousGood: 0, good: undefined, quantity: 100, pause: false })).toBe("completed");
  });
});

describe("closedTotals", () => {
  it("sums what was reported on the closed runs only", () => {
    const runs = [
      run({ endedAt: "2026-10-13T09:00:00.000Z", endReason: "paused", reportedGood: 40, reportedScrap: 3, countedGood: 45 }),
      run({ endedAt: "2026-10-13T11:00:00.000Z", endReason: "paused", reportedGood: 25, reportedScrap: 1 }),
      run({ reportedGood: 999 }),
    ];
    expect(closedTotals(runs)).toEqual({ good: 65, scrap: 4 });
  });
});

describe("paused status", () => {
  it("is a status a work order can be set to", () => {
    expect(WORK_ORDER_STATUSES).toContain("paused");
    const parsed = parseWorkOrderPatch({ status: "paused" });
    expect(parsed.ok && parsed.value.status).toBe("paused");
  });
  it("a paused order can be cancelled in bulk", () => {
    expect(BULK_ELIGIBLE.cancel.from).toContain("paused");
    expect(BULK_ELIGIBLE.release.from).not.toContain("paused");
  });
});
