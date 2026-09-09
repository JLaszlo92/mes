import { describe, expect, it } from "vitest";
import { stateStore } from "../state.js";

describe("MachineStateStore", () => {
  const machineId = "m-state-test";

  it("defaults to idle with zero counts for an unseen machine", () => {
    expect(stateStore.get(machineId)).toBeUndefined();
  });

  it("applies a machine_status event", () => {
    stateStore.applyEvent({
      type: "machine_status",
      machineId,
      timestamp: new Date().toISOString(),
      sourceEventId: "s1",
      status: "running",
    });
    expect(stateStore.get(machineId)?.status).toBe("running");
  });

  it("accumulates good/scrap counts", () => {
    stateStore.applyEvent({
      type: "production_count",
      machineId,
      timestamp: new Date().toISOString(),
      sourceEventId: "s2",
      result: "good",
    });
    stateStore.applyEvent({
      type: "production_count",
      machineId,
      timestamp: new Date().toISOString(),
      sourceEventId: "s3",
      result: "scrap",
      scrapReasonCode: "misalign",
    });
    const state = stateStore.get(machineId);
    expect(state?.goodCount).toBe(1);
    expect(state?.scrapCount).toBe(1);
  });
});
