/**
 * Validation and change handling for edge node channels (the PLC connection of
 * one machine). Pure (no db import) so it is testable without a database.
 *
 * Principles:
 *  - Known connection keys are checked for type and range; unknown keys are
 *    kept untouched (channels created by hand or by older versions may carry
 *    more than the dashboard knows about).
 *  - On a PATCH, `connectionConfig` is a partial update: a key set to null is
 *    removed, other keys are set, keys that are not mentioned stay. The merged
 *    result is validated only when the patch touched the connection, so a
 *    legacy channel with an odd config can still be moved to another machine.
 */

export type SignalSource = "simulated" | "gpio" | "s7" | "opcua" | "modbus";
export type StatusMode = "status_bit" | "signal_presence";

export interface ChannelFields {
  machineId: string | null;
  signalSource: SignalSource;
  connectionConfig: Record<string, unknown>;
  statusMode: StatusMode;
  noSignalTimeoutSeconds: number;
  acceptProductionWhileDown: boolean;
}

export type Invalid = { ok: false; error: string; field: string };
export type Valid<T> = { ok: true; value: T };

const SOURCES: readonly SignalSource[] = ["simulated", "gpio", "s7", "opcua", "modbus"];
const MODES: readonly StatusMode[] = ["status_bit", "signal_presence"];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const fail = (field: string, error: string): Invalid => ({ ok: false, field, error });

type Rule =
  | { key: string; kind: "text"; required?: boolean; max?: number }
  | { key: string; kind: "url"; required?: boolean }
  | { key: string; kind: "int"; min: number; max: number }
  | { key: string; kind: "pin" };

const RULES: Record<SignalSource, Rule[]> = {
  modbus: [
    { key: "host", kind: "text", required: true, max: 253 },
    { key: "port", kind: "int", min: 1, max: 65535 },
    { key: "unitId", kind: "int", min: 0, max: 255 },
    { key: "goodCountRegister", kind: "int", min: 0, max: 65535 },
    { key: "scrapCountRegister", kind: "int", min: 0, max: 65535 },
    { key: "statusRegister", kind: "int", min: 0, max: 65535 },
  ],
  opcua: [
    { key: "endpointUrl", kind: "url", required: true },
    { key: "goodCountNodeId", kind: "text", max: 512 },
    { key: "scrapCountNodeId", kind: "text", max: 512 },
    { key: "statusNodeId", kind: "text", max: 512 },
  ],
  s7: [
    { key: "plcIp", kind: "text", required: true, max: 253 },
    { key: "plcRack", kind: "int", min: 0, max: 7 },
    { key: "plcSlot", kind: "int", min: 0, max: 31 },
    { key: "plcPort", kind: "int", min: 1, max: 65535 },
  ],
  gpio: [
    { key: "goodPin", kind: "pin" },
    { key: "scrapPin", kind: "pin" },
    { key: "statusPin", kind: "pin" },
  ],
  simulated: [],
};

/** Returns the normalized config (known strings trimmed) or the first problem. */
export function validateConnectionConfig(
  source: SignalSource,
  config: Record<string, unknown>,
): Valid<Record<string, unknown>> | Invalid {
  const out: Record<string, unknown> = { ...config };
  for (const rule of RULES[source]) {
    const field = `connectionConfig.${rule.key}`;
    let v = out[rule.key];
    if (typeof v === "string") {
      v = v.trim();
      if (v === "") v = undefined;
    }
    if (v === undefined || v === null) {
      if ("required" in rule && rule.required) return fail(field, `${rule.key} is required for ${source}`);
      delete out[rule.key];
      continue;
    }
    switch (rule.kind) {
      case "text":
        if (typeof v !== "string" || v.length > (rule.max ?? 253)) return fail(field, `${rule.key} must be a text of at most ${rule.max ?? 253} characters`);
        break;
      case "url":
        if (typeof v !== "string" || !/^opc\.tcp:\/\/\S+$/i.test(v)) return fail(field, `${rule.key} must look like opc.tcp://host:port/path`);
        break;
      case "int":
        if (!isInt(v, rule.min, rule.max)) return fail(field, `${rule.key} must be a whole number between ${rule.min} and ${rule.max}`);
        break;
      case "pin":
        if (!(isInt(v, 0, 999) || (typeof v === "string" && v.length <= 32))) return fail(field, `${rule.key} must be a pin number or name`);
        break;
    }
    out[rule.key] = v;
  }
  return { ok: true, value: out };
}

function machineIdOf(v: unknown): string | null | Invalid {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return fail("machineId", "machineId must be a text or null");
  const t = v.trim();
  return t === "" ? null : t;
}

function commonFields(
  input: Record<string, unknown>,
  base: Pick<ChannelFields, "statusMode" | "noSignalTimeoutSeconds" | "acceptProductionWhileDown">,
): Valid<Pick<ChannelFields, "statusMode" | "noSignalTimeoutSeconds" | "acceptProductionWhileDown">> | Invalid {
  // Pick explicitly: `base` may be a whole ChannelFields and must not leak its other fields.
  const out = {
    statusMode: base.statusMode,
    noSignalTimeoutSeconds: base.noSignalTimeoutSeconds,
    acceptProductionWhileDown: base.acceptProductionWhileDown,
  };
  if (input.statusMode !== undefined) {
    if (!MODES.includes(input.statusMode as StatusMode)) return fail("statusMode", `statusMode must be one of: ${MODES.join(", ")}`);
    out.statusMode = input.statusMode as StatusMode;
  }
  if (input.noSignalTimeoutSeconds !== undefined) {
    if (!isInt(input.noSignalTimeoutSeconds, 1, 86400)) return fail("noSignalTimeoutSeconds", "noSignalTimeoutSeconds must be a whole number between 1 and 86400");
    out.noSignalTimeoutSeconds = input.noSignalTimeoutSeconds;
  }
  if (input.acceptProductionWhileDown !== undefined) {
    if (typeof input.acceptProductionWhileDown !== "boolean") return fail("acceptProductionWhileDown", "acceptProductionWhileDown must be true or false");
    out.acceptProductionWhileDown = input.acceptProductionWhileDown;
  }
  return { ok: true, value: out };
}

/** POST body of a new channel. */
export function validateChannelCreate(body: unknown): Valid<ChannelFields> | Invalid {
  if (!isObject(body)) return fail("body", "body must be a JSON object");
  if (!SOURCES.includes(body.signalSource as SignalSource)) {
    return fail("signalSource", `signalSource must be one of: ${SOURCES.join(", ")}`);
  }
  const signalSource = body.signalSource as SignalSource;
  const machineId = machineIdOf(body.machineId);
  if (typeof machineId === "object" && machineId !== null) return machineId;
  const common = commonFields(body, { statusMode: "status_bit", noSignalTimeoutSeconds: 60, acceptProductionWhileDown: true });
  if (!common.ok) return common;
  const rawConfig = body.connectionConfig ?? {};
  if (!isObject(rawConfig)) return fail("connectionConfig", "connectionConfig must be an object");
  const config = validateConnectionConfig(signalSource, rawConfig);
  if (!config.ok) return config;
  return { ok: true, value: { machineId, signalSource, connectionConfig: config.value, ...common.value } };
}

const PATCHABLE = new Set(["machineId", "signalSource", "connectionConfig", "statusMode", "noSignalTimeoutSeconds", "acceptProductionWhileDown"]);

/** PATCH body applied to the current state of a channel. */
export function mergeChannelPatch(existing: ChannelFields, body: unknown): Valid<ChannelFields> | Invalid {
  if (!isObject(body)) return fail("body", "body must be a JSON object");
  const keys = Object.keys(body);
  if (keys.length === 0) return fail("body", "no fields given");
  for (const k of keys) if (!PATCHABLE.has(k)) return fail(k, `unknown field: ${k}`);

  if (body.signalSource !== undefined && body.signalSource !== existing.signalSource) {
    return fail("signalSource", "the protocol of a channel cannot be changed; remove the channel and add a new one");
  }

  let machineId = existing.machineId;
  if ("machineId" in body) {
    const m = machineIdOf(body.machineId);
    if (typeof m === "object" && m !== null) return m;
    machineId = m;
  }

  const common = commonFields(body, existing);
  if (!common.ok) return common;

  let connectionConfig = existing.connectionConfig;
  if (body.connectionConfig !== undefined) {
    if (!isObject(body.connectionConfig)) return fail("connectionConfig", "connectionConfig must be an object");
    const merged: Record<string, unknown> = { ...existing.connectionConfig };
    for (const [k, v] of Object.entries(body.connectionConfig)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    const checked = validateConnectionConfig(existing.signalSource, merged);
    if (!checked.ok) return checked;
    connectionConfig = checked.value;
  }

  return {
    ok: true,
    value: { machineId, signalSource: existing.signalSource, connectionConfig, ...common.value },
  };
}

/** Fields that differ, for the audit log: { field: { from, to } }. */
export function diffChannel(before: ChannelFields, after: ChannelFields): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const key of ["machineId", "statusMode", "noSignalTimeoutSeconds", "acceptProductionWhileDown"] as const) {
    if (!same(before[key], after[key])) changes[key] = { from: before[key], to: after[key] };
  }
  const keys = new Set([...Object.keys(before.connectionConfig), ...Object.keys(after.connectionConfig)]);
  for (const k of [...keys].sort()) {
    if (!same(before.connectionConfig[k], after.connectionConfig[k])) {
      changes[`connectionConfig.${k}`] = { from: before.connectionConfig[k] ?? null, to: after.connectionConfig[k] ?? null };
    }
  }
  return changes;
}
