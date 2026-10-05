import { apiFetch, API_BASE } from "./api.js";
import { readJsonOrThrow } from "./master-data.js";

/**
 * Shared by the Admin -> Edge nodes screen and the machine editor: the types of
 * edge nodes and channels, the connection fields of each protocol, and the
 * conversion between the form (all text) and the API bodies.
 */

export type SignalSource = "simulated" | "gpio" | "s7" | "opcua" | "modbus";
export type StatusMode = "status_bit" | "signal_presence";

export interface EdgeNodeChannel {
  id: string;
  edgeNodeId?: string;
  machineId: string | null;
  machineName: string | null;
  signalSource: SignalSource;
  statusMode: StatusMode;
  noSignalTimeoutSeconds: number;
  acceptProductionWhileDown: boolean;
  connectionConfig: Record<string, unknown>;
}

export interface EdgeNode {
  id: string;
  name: string;
  isOnline: boolean;
  lastHeartbeatAt: string | null;
  lastSeenAt?: string | null;
  channels: EdgeNodeChannel[];
  settings?: { catchupMaxMinutes: number };
}

/** JSON call to our backend. apiFetch adds the session token and signs out on a 401; errors are ApiError with the server's field. */
export async function api<T = unknown>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await apiFetch(`${API_BASE}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return readJsonOrThrow<T>(res);
}

export const fetchEdgeNodes = () => api<EdgeNode[]>("/api/edge-nodes", "GET");

export type FieldKind = "text" | "int" | "pin";
export interface FieldDef {
  key: string;
  label: string;
  placeholder?: string;
  width: number;
  kind: FieldKind;
}

export const FIELDS: Record<SignalSource, FieldDef[]> = {
  modbus: [
    { key: "host", label: "Host", placeholder: "192.168.1.20", width: 150, kind: "text" },
    { key: "port", label: "Port", placeholder: "502", width: 80, kind: "int" },
    { key: "unitId", label: "Unit ID", placeholder: "1", width: 70, kind: "int" },
    { key: "goodCountRegister", label: "Good register", width: 100, kind: "int" },
    { key: "scrapCountRegister", label: "Scrap register", width: 100, kind: "int" },
    { key: "statusRegister", label: "Status register", width: 100, kind: "int" },
  ],
  opcua: [
    { key: "endpointUrl", label: "Endpoint URL", placeholder: "opc.tcp://192.168.1.30:4840", width: 250, kind: "text" },
    { key: "goodCountNodeId", label: "Good node ID", width: 160, kind: "text" },
    { key: "scrapCountNodeId", label: "Scrap node ID", width: 160, kind: "text" },
    { key: "statusNodeId", label: "Status node ID", width: 160, kind: "text" },
  ],
  s7: [
    { key: "plcIp", label: "PLC IP", placeholder: "192.168.1.40", width: 150, kind: "text" },
    { key: "plcRack", label: "Rack", placeholder: "0", width: 70, kind: "int" },
    { key: "plcSlot", label: "Slot", placeholder: "1", width: 70, kind: "int" },
    { key: "plcPort", label: "Port", placeholder: "102", width: 80, kind: "int" },
  ],
  gpio: [
    { key: "goodPin", label: "Good pin", width: 90, kind: "pin" },
    { key: "scrapPin", label: "Scrap pin", width: 90, kind: "pin" },
    { key: "statusPin", label: "Status pin", width: 90, kind: "pin" },
  ],
  simulated: [],
};

export const PROTOCOLS: { value: SignalSource; label: string }[] = [
  { value: "modbus", label: "Modbus TCP" },
  { value: "opcua", label: "OPC-UA" },
  { value: "s7", label: "S7" },
  { value: "gpio", label: "GPIO" },
  { value: "simulated", label: "Simulated" },
];
export const protocolLabel = (s: SignalSource) => PROTOCOLS.find((p) => p.value === s)?.label ?? s;

export interface ChannelForm {
  machineId: string;
  signalSource: SignalSource;
  statusMode: StatusMode;
  noSignalTimeoutSeconds: string;
  acceptProductionWhileDown: boolean;
  config: Record<string, string>;
}

export function emptyChannelForm(machineId = ""): ChannelForm {
  return {
    machineId,
    signalSource: "modbus",
    statusMode: "status_bit",
    noSignalTimeoutSeconds: "60",
    acceptProductionWhileDown: true,
    config: {},
  };
}

export function formFromChannel(c: EdgeNodeChannel): ChannelForm {
  const config: Record<string, string> = {};
  for (const f of FIELDS[c.signalSource]) {
    const v = c.connectionConfig?.[f.key];
    config[f.key] = v === undefined || v === null ? "" : String(v);
  }
  return {
    machineId: c.machineId ?? "",
    signalSource: c.signalSource,
    statusMode: c.statusMode,
    noSignalTimeoutSeconds: String(c.noSignalTimeoutSeconds),
    acceptProductionWhileDown: c.acceptProductionWhileDown,
    config,
  };
}

/** A number the user typed; anything that is not a finite number is sent as text so the server rejects it (NaN would become null). */
export function toNumber(raw: string): number | string {
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) ? n : raw;
}

/** create: blank fields are left out. patch: blank fields are sent as null, which clears them. */
export function buildConnectionConfig(form: ChannelForm, mode: "create" | "patch"): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS[form.signalSource]) {
    const raw = (form.config[f.key] ?? "").trim();
    if (raw === "") {
      if (mode === "patch") out[f.key] = null;
      continue;
    }
    if (f.kind === "int") out[f.key] = toNumber(raw);
    else if (f.kind === "pin") out[f.key] = /^\d+$/.test(raw) ? Number(raw) : raw;
    else out[f.key] = raw;
  }
  return out;
}

export const channelCreateBody = (form: ChannelForm) => ({
  machineId: form.machineId || undefined,
  signalSource: form.signalSource,
  connectionConfig: buildConnectionConfig(form, "create"),
  statusMode: form.statusMode,
  noSignalTimeoutSeconds: toNumber(form.noSignalTimeoutSeconds),
  acceptProductionWhileDown: form.acceptProductionWhileDown,
});

export const channelPatchBody = (form: ChannelForm) => ({
  machineId: form.machineId || null,
  statusMode: form.statusMode,
  noSignalTimeoutSeconds: toNumber(form.noSignalTimeoutSeconds),
  acceptProductionWhileDown: form.acceptProductionWhileDown,
  connectionConfig: buildConnectionConfig(form, "patch"),
});

export const addChannel = (edgeNodeId: string, form: ChannelForm) =>
  api<EdgeNodeChannel>(`/api/edge-nodes/${encodeURIComponent(edgeNodeId)}/channels`, "POST", channelCreateBody(form));

export const updateChannel = (channelId: string, body: Record<string, unknown>) =>
  api<EdgeNodeChannel>(`/api/edge-node-channels/${encodeURIComponent(channelId)}`, "PATCH", body);

export function describeConnection(c: EdgeNodeChannel): string {
  const cfg = c.connectionConfig ?? {};
  const s = (k: string) => (cfg[k] === undefined || cfg[k] === null ? "" : String(cfg[k]));
  switch (c.signalSource) {
    case "modbus":
      return s("host") ? `${s("host")}:${s("port") || "502"}${s("unitId") ? ` · unit ${s("unitId")}` : ""}` : "no host set";
    case "opcua":
      return s("endpointUrl") || "no endpoint set";
    case "s7":
      return s("plcIp") ? `${s("plcIp")}${s("plcRack") || s("plcSlot") ? ` · rack ${s("plcRack") || "0"} / slot ${s("plcSlot") || "0"}` : ""}` : "no PLC address set";
    case "gpio":
      return ["goodPin", "scrapPin", "statusPin"].filter(s).map((k) => `${k.replace("Pin", "")} ${s(k)}`).join(" · ") || "no pins set";
    default:
      return "simulated signal";
  }
}
