import { describe, expect, it } from "vitest";
import { configRevision, type RevisionChannel } from "../edge-node-revision.js";

const ch = (over: Partial<RevisionChannel> = {}): RevisionChannel => ({
  machineId: "modbus-rig-01",
  signalSource: "modbus",
  connectionConfig: { host: "10.0.0.5", port: 502, unitId: 1 },
  statusMode: "status_bit",
  noSignalTimeoutSeconds: 60,
  acceptProductionWhileDown: false,
  ...over,
});
const settings = { catchupMaxMinutes: 10 };

describe("configRevision", () => {
  it("is a short hex string and stable", () => {
    expect(configRevision([ch()], settings)).toMatch(/^[0-9a-f]{16}$/);
    expect(configRevision([ch()], settings)).toBe(configRevision([ch()], settings));
  });
  it("does not depend on key order or channel order", () => {
    const a = ch({ connectionConfig: { host: "h", port: 1 } });
    const b = ch({ connectionConfig: { port: 1, host: "h" } });
    expect(configRevision([a], settings)).toBe(configRevision([b], settings));
    const c2 = ch({ machineId: "opcua-rig-01", signalSource: "opcua" });
    expect(configRevision([ch(), c2], settings)).toBe(configRevision([c2, ch()], settings));
  });
  it("changes with every field the agent uses", () => {
    const base = configRevision([ch()], settings);
    for (const over of [
      { machineId: "other" },
      { signalSource: "opcua" },
      { connectionConfig: { host: "10.0.0.6", port: 502, unitId: 1 } },
      { statusMode: "signal_presence" },
      { noSignalTimeoutSeconds: 90 },
      { acceptProductionWhileDown: true },
    ] as Partial<RevisionChannel>[]) {
      expect(configRevision([ch(over)], settings)).not.toBe(base);
    }
    expect(configRevision([ch()], { catchupMaxMinutes: 1 })).not.toBe(base);
  });
  it("changes when a channel is added or removed", () => {
    expect(configRevision([ch(), ch({ machineId: "x" })], settings)).not.toBe(configRevision([ch()], settings));
  });
  it("ignores channels without a machine and fields the agent does not use", () => {
    const base = configRevision([ch()], settings);
    expect(configRevision([ch(), ch({ machineId: null })], settings)).toBe(base);
    expect(configRevision([{ ...ch(), machineName: "Renamed", id: "c9" } as RevisionChannel], settings)).toBe(base);
  });
  it("treats a missing connectionConfig like an empty one", () => {
    expect(configRevision([ch({ connectionConfig: undefined })], settings)).toBe(configRevision([ch({ connectionConfig: {} })], settings));
  });
});
