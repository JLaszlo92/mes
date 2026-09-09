import { describe, expect, it } from "vitest";
import {
  eventTopic,
  machineIdFromTopic,
  parseMachineEvent,
  safeParseMachineEvent,
} from "../index.js";

describe("events", () => {
  it("parses a valid production_count event", () => {
    const event = parseMachineEvent({
      type: "production_count",
      machineId: "m-01",
      timestamp: new Date().toISOString(),
      sourceEventId: "abc-123",
      result: "good",
    });
    expect(event.type).toBe("production_count");
  });

  it("parses a valid machine_status event", () => {
    const event = parseMachineEvent({
      type: "machine_status",
      machineId: "m-01",
      timestamp: new Date().toISOString(),
      sourceEventId: "abc-124",
      status: "running",
    });
    expect(event.type).toBe("machine_status");
  });

  it("rejects an event with an unknown type instead of silently letting it through", () => {
    const result = safeParseMachineEvent({
      type: "vibration_reading",
      machineId: "m-01",
      timestamp: new Date().toISOString(),
      sourceEventId: "abc-125",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed timestamp", () => {
    const result = safeParseMachineEvent({
      type: "machine_status",
      machineId: "m-01",
      timestamp: "not-a-date",
      sourceEventId: "abc-126",
      status: "running",
    });
    expect(result.success).toBe(false);
  });
});

describe("topics", () => {
  it("builds and parses a machine event topic", () => {
    const topic = eventTopic("m-01");
    expect(topic).toBe("mes/machines/m-01/events");
    expect(machineIdFromTopic(topic)).toBe("m-01");
  });

  it("returns null for a topic that doesn't match the convention", () => {
    expect(machineIdFromTopic("mes/machines/m-01/status/extra")).toBeNull();
  });
});
