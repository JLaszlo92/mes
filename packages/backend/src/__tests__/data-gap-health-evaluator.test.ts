import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, raise, resolve } = vi.hoisted(() => ({ query: vi.fn(), raise: vi.fn(), resolve: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query } }));
vi.mock("../alerts-repository.js", () => ({ raiseOrUpdateSystemAlert: raise, resolveSystemAlert: resolve }));

import { assessDataGaps, createDataGapCheck, dataGapWindowHoursFromEnv, type DataGapSummary } from "../data-gap-health-evaluator.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const gap = (over: Partial<DataGapSummary> = {}): DataGapSummary => ({
  machineId: "modbus-rig-01",
  machineName: "Modbus Rig 01",
  gaps: 2,
  lostGood: 149,
  lostScrap: 13,
  lastAt: new Date("2026-10-08T19:51:26.843Z"),
  ...over,
});

describe("assessDataGaps", () => {
  it("is healthy without a gap in the window", () => {
    expect(assessDataGaps([], 24)).toEqual({ healthy: true });
  });

  it("names the machine, the gaps, the lost parts and the latest time", () => {
    const h = assessDataGaps([gap()], 24);
    expect(h.healthy).toBe(false);
    const m = (h as { message: string }).message;
    expect(m).toContain("1 machine in the last 24 h");
    expect(m).toContain("Modbus Rig 01 — 2 gaps, 149 good + 13 scrap parts not booked (latest 2026-10-08 19:51 UTC)");
  });

  it("uses the machine id when the machine has no name, and says 'gap' for one", () => {
    const m = (assessDataGaps([gap({ machineName: null, gaps: 1 })], 24) as { message: string }).message;
    expect(m).toContain("modbus-rig-01 — 1 gap,");
  });

  it("lists the most recent machines first and cuts the list after five", () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      gap({ machineId: `m${i}`, machineName: `M${i}`, lastAt: new Date(Date.UTC(2026, 9, 8, 10 + i)) }),
    );
    const m = (assessDataGaps(rows, 24) as { message: string }).message;
    expect(m).toContain("7 machines");
    expect(m.indexOf("M6")).toBeLessThan(m.indexOf("M5"));
    expect(m).not.toContain("M0 —");
    expect(m).toContain("and 2 more");
  });

  it("keeps the text the same for the same data (the alert is only updated when the text changes)", () => {
    expect(assessDataGaps([gap()], 24)).toEqual(assessDataGaps([gap()], 24));
  });
});

describe("createDataGapCheck", () => {
  beforeEach(() => {
    query.mockReset();
    raise.mockReset().mockResolvedValue(true);
    resolve.mockReset().mockResolvedValue(false);
  });

  it("raises one data_gap system alert from the events of the window", async () => {
    query.mockResolvedValueOnce({
      rows: [{ machine_id: "s7-rig-01", name: "S7 Rig 01", gaps: 1, lost_good: 47, lost_scrap: 3, last_at: new Date("2026-10-08T19:51:26.103Z") }],
    });
    await createDataGapCheck(log, 24)();
    expect(query.mock.calls[0]![1]).toEqual([24 * 3600]);
    expect(raise).toHaveBeenCalledTimes(1);
    expect(raise.mock.calls[0]![0]).toBe("data_gap");
    expect(raise.mock.calls[0]![1]).toContain("S7 Rig 01 — 1 gap, 47 good + 3 scrap");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("resolves the alert when the window is clean", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    resolve.mockResolvedValueOnce(true);
    await createDataGapCheck(log, 24)();
    expect(resolve).toHaveBeenCalledWith("data_gap");
    expect(raise).not.toHaveBeenCalled();
  });
});

describe("window from the environment", () => {
  it("defaults to 24 h and reads DATA_GAP_ALERT_HOURS", () => {
    expect(dataGapWindowHoursFromEnv({})).toBe(24);
    expect(dataGapWindowHoursFromEnv({ DATA_GAP_ALERT_HOURS: "6" })).toBe(6);
    expect(dataGapWindowHoursFromEnv({ DATA_GAP_ALERT_HOURS: "nonsense" })).toBe(24);
    expect(dataGapWindowHoursFromEnv({ DATA_GAP_ALERT_HOURS: "0" })).toBe(24);
  });
});
