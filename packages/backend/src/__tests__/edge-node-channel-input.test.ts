import { describe, expect, it } from "vitest";
import {
  diffChannel,
  mergeChannelPatch,
  validateChannelCreate,
  validateConnectionConfig,
  type ChannelFields,
} from "../edge-node-channel-input.js";

const modbus: ChannelFields = {
  machineId: "m1",
  signalSource: "modbus",
  connectionConfig: { host: "10.0.0.5", port: 502, unitId: 1, goodCountRegister: 10, legacyKey: "keep-me" },
  statusMode: "status_bit",
  noSignalTimeoutSeconds: 60,
  acceptProductionWhileDown: true,
};

describe("validateChannelCreate", () => {
  it("accepts a modbus channel, trims text and applies defaults", () => {
    const r = validateChannelCreate({ signalSource: "modbus", machineId: "m1", connectionConfig: { host: " 10.0.0.5 ", port: 502 } });
    expect(r).toEqual({
      ok: true,
      value: {
        machineId: "m1", signalSource: "modbus", connectionConfig: { host: "10.0.0.5", port: 502 },
        statusMode: "status_bit", noSignalTimeoutSeconds: 60, acceptProductionWhileDown: true,
      },
    });
  });
  it("treats an empty machineId as unassigned", () => {
    const r = validateChannelCreate({ signalSource: "simulated", machineId: "" });
    expect(r.ok && r.value.machineId).toBeNull();
  });
  it("rejects what the agent could not use", () => {
    const bad = (body: unknown) => { const r = validateChannelCreate(body); return r.ok ? null : r.field; };
    expect(bad(null)).toBe("body");
    expect(bad({})).toBe("signalSource");
    expect(bad({ signalSource: "profibus" })).toBe("signalSource");
    expect(bad({ signalSource: "modbus", connectionConfig: {} })).toBe("connectionConfig.host");
    expect(bad({ signalSource: "modbus", connectionConfig: { host: "h", port: 70000 } })).toBe("connectionConfig.port");
    expect(bad({ signalSource: "modbus", connectionConfig: { host: "h", port: "502" } })).toBe("connectionConfig.port");
    expect(bad({ signalSource: "modbus", connectionConfig: { host: "h", port: 1.5 } })).toBe("connectionConfig.port");
    expect(bad({ signalSource: "opcua", connectionConfig: { endpointUrl: "http://x" } })).toBe("connectionConfig.endpointUrl");
    expect(bad({ signalSource: "s7", connectionConfig: { plcIp: "1.2.3.4", plcRack: 9 } })).toBe("connectionConfig.plcRack");
    expect(bad({ signalSource: "s7", connectionConfig: { plcIp: "1.2.3.4", plcSlot: 40 } })).toBe("connectionConfig.plcSlot");
    expect(bad({ signalSource: "modbus", connectionConfig: { host: "h" }, statusMode: "x" })).toBe("statusMode");
    expect(bad({ signalSource: "modbus", connectionConfig: { host: "h" }, noSignalTimeoutSeconds: 0 })).toBe("noSignalTimeoutSeconds");
    expect(bad({ signalSource: "modbus", connectionConfig: { host: "h" }, acceptProductionWhileDown: "yes" })).toBe("acceptProductionWhileDown");
    expect(bad({ signalSource: "modbus", machineId: 5, connectionConfig: { host: "h" } })).toBe("machineId");
    expect(bad({ signalSource: "modbus", connectionConfig: [] })).toBe("connectionConfig");
  });
  it("accepts opcua, s7 and gpio shapes and the simulated source without config", () => {
    expect(validateChannelCreate({ signalSource: "opcua", connectionConfig: { endpointUrl: "opc.tcp://10.0.0.7:4840", goodCountNodeId: "ns=2;s=Good" } }).ok).toBe(true);
    expect(validateChannelCreate({ signalSource: "s7", connectionConfig: { plcIp: "10.0.0.8", plcRack: 0, plcSlot: 1, plcPort: 102 } }).ok).toBe(true);
    expect(validateChannelCreate({ signalSource: "gpio", connectionConfig: { goodPin: 17, scrapPin: "GPIO18" } }).ok).toBe(true);
    expect(validateChannelCreate({ signalSource: "simulated" }).ok).toBe(true);
  });
  it("keeps unknown connection keys", () => {
    const r = validateConnectionConfig("modbus", { host: "h", somethingNew: 1 });
    expect(r.ok && r.value).toEqual({ host: "h", somethingNew: 1 });
  });
});

describe("mergeChannelPatch", () => {
  it("changes only the given fields and keeps the rest of the connection", () => {
    const r = mergeChannelPatch(modbus, { connectionConfig: { host: "10.0.0.9" }, noSignalTimeoutSeconds: 90 });
    expect(r.ok && r.value).toEqual({
      ...modbus,
      connectionConfig: { host: "10.0.0.9", port: 502, unitId: 1, goodCountRegister: 10, legacyKey: "keep-me" },
      noSignalTimeoutSeconds: 90,
    });
  });
  it("removes a connection key set to null and re-checks the result", () => {
    const r = mergeChannelPatch(modbus, { connectionConfig: { goodCountRegister: null, port: null } });
    expect(r.ok && r.value.connectionConfig).toEqual({ host: "10.0.0.9".replace("9", "5"), unitId: 1, legacyKey: "keep-me" });
    const missingHost = mergeChannelPatch(modbus, { connectionConfig: { host: null } });
    expect(missingHost.ok).toBe(false);
    expect(!missingHost.ok && missingHost.field).toBe("connectionConfig.host");
  });
  it("moves a machine and unassigns with null or an empty text", () => {
    expect(mergeChannelPatch(modbus, { machineId: "m2" }).ok && (mergeChannelPatch(modbus, { machineId: "m2" }) as any).value.machineId).toBe("m2");
    expect((mergeChannelPatch(modbus, { machineId: null }) as any).value.machineId).toBeNull();
    expect((mergeChannelPatch(modbus, { machineId: "" }) as any).value.machineId).toBeNull();
  });
  it("does not re-validate an untouched legacy connection", () => {
    const legacy: ChannelFields = { ...modbus, connectionConfig: { port: 502 } }; // no host
    expect(mergeChannelPatch(legacy, { machineId: "m3" }).ok).toBe(true);
    expect(mergeChannelPatch(legacy, { connectionConfig: { port: 503 } }).ok).toBe(false);
  });
  it("refuses a protocol change, unknown fields, empty and non-object bodies", () => {
    const field = (b: unknown) => { const r = mergeChannelPatch(modbus, b); return r.ok ? null : r.field; };
    expect(field({ signalSource: "s7" })).toBe("signalSource");
    expect(field({ signalSource: "modbus", statusMode: "signal_presence" })).toBeNull();
    expect(field({ id: "x" })).toBe("id");
    expect(field({})).toBe("body");
    expect(field([])).toBe("body");
    expect(field({ statusMode: "nope" })).toBe("statusMode");
    expect(field({ connectionConfig: "x" })).toBe("connectionConfig");
  });
});

describe("diffChannel", () => {
  it("lists changed fields and connection keys only", () => {
    const after = mergeChannelPatch(modbus, { machineId: "m2", connectionConfig: { host: "10.0.0.9", unitId: null } });
    expect(after.ok && diffChannel(modbus, after.value)).toEqual({
      machineId: { from: "m1", to: "m2" },
      "connectionConfig.host": { from: "10.0.0.5", to: "10.0.0.9" },
      "connectionConfig.unitId": { from: 1, to: null },
    });
  });
  it("is empty for an identical channel", () => {
    expect(diffChannel(modbus, { ...modbus })).toEqual({});
  });
});
