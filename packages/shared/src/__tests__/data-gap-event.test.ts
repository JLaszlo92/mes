import { describe, expect, it } from "vitest";
import { MachineEventSchema, safeParseMachineEvent } from "../events.js";

const base = { machineId: "m1", timestamp: "2026-10-08T19:00:00.000Z", sourceEventId: "e1" };

describe("data_gap event", () => {
  it("accepts a gap with a known length", () => {
    const r = safeParseMachineEvent({ ...base, type: "data_gap", reason: "too_old", gapSeconds: 900, lostGood: 120, lostScrap: 3 });
    expect(r.success).toBe(true);
  });
  it("accepts an unknown length (clock set back) and a reason a newer agent may add", () => {
    expect(safeParseMachineEvent({ ...base, type: "data_gap", reason: "clock_back", gapSeconds: null, lostGood: 1, lostScrap: 0 }).success).toBe(true);
    expect(safeParseMachineEvent({ ...base, type: "data_gap", reason: "something_new", gapSeconds: 5, lostGood: 1, lostScrap: 0 }).success).toBe(true);
  });
  it("rejects negative or fractional counts and a missing reason", () => {
    expect(safeParseMachineEvent({ ...base, type: "data_gap", reason: "too_old", gapSeconds: 1, lostGood: -1, lostScrap: 0 }).success).toBe(false);
    expect(safeParseMachineEvent({ ...base, type: "data_gap", reason: "too_old", gapSeconds: 1, lostGood: 1.5, lostScrap: 0 }).success).toBe(false);
    expect(safeParseMachineEvent({ ...base, type: "data_gap", gapSeconds: 1, lostGood: 1, lostScrap: 0 }).success).toBe(false);
  });
  it("leaves the other event types unchanged", () => {
    expect(MachineEventSchema.safeParse({ ...base, type: "production_count", result: "good" }).success).toBe(true);
    expect(MachineEventSchema.safeParse({ ...base, type: "machine_status", status: "running" }).success).toBe(true);
    expect(MachineEventSchema.safeParse({ ...base, type: "nope" }).success).toBe(false);
  });
});
