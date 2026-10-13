/**
 * A terminál (gép melletti tablet) hívásai. Nem a dashboard sessionjét
 * használja: a párosított eszköz tokenje (`X-Terminal-Token`) azonosítja,
 * a módosításokhoz pedig a dolgozó PIN-jével kapott jegy (`X-Worker-Ticket`).
 */
import { API_BASE } from "./api.js";
import type { WorkInstruction } from "./work-instructions.js";
import type { CheckDetail, CheckKind, QualityCheck } from "./quality.js";

const KEY = (terminalId: string) => `mes-terminal-device:${terminalId}`;

export function readDeviceToken(terminalId: string): string | null {
  try {
    return localStorage.getItem(KEY(terminalId));
  } catch {
    return null;
  }
}

/** A pairing link ends in `#pair=<token>`: store it and remove it from the address bar. */
export function takePairingToken(terminalId: string): void {
  const match = window.location.hash.match(/^#pair=([A-Za-z0-9_-]{20,})$/);
  if (!match) return;
  try {
    localStorage.setItem(KEY(terminalId), match[1]!);
  } catch {
    // Without storage the device cannot stay paired; the page says so (not paired).
  }
  window.history.replaceState(null, "", window.location.pathname);
}

export function forgetDeviceToken(terminalId: string): void {
  try {
    localStorage.removeItem(KEY(terminalId));
  } catch {
    // nothing stored
  }
}

export class TerminalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** The rest of the error body (e.g. checkId of a quality check that has to be done first). */
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function request<T>(terminalId: string, path: string, init: { method?: string; body?: unknown; ticket?: string | null } = {}): Promise<T> {
  const token = readDeviceToken(terminalId);
  if (!token) throw new TerminalError("not paired", 401, "terminal_not_paired");
  const headers: Record<string, string> = { "X-Terminal-Token": token };
  if (init.ticket) headers["X-Worker-Ticket"] = init.ticket;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_BASE}/api/terminal/${encodeURIComponent(terminalId)}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new TerminalError(data.error ?? `${res.status} ${res.statusText}`, res.status, data.code, data as Record<string, unknown>);
  return data as T;
}

export interface TerminalAssignment {
  id: string;
  workOrderId: string;
  plannedStart: string;
  plannedEnd: string;
  orderNumber: string;
  partName: string;
  quantity: number;
  workOrderStatus: string;
}

export interface StatusOption {
  code: string;
  label: string;
  oeeCategory: string;
  color: string | null;
  blocksProduction: boolean;
}

export interface TerminalMachine {
  id: string;
  name: string;
  /** The current status (latest status event) and, if a worker set it, who and when. */
  status: { code: string; since: string; manual: { code: string; setBy: string | null; setAt: string; blocksProduction: boolean } | null } | null;
  /** What a worker may set (Admin → Status definitions). */
  statusOptions: StatusOption[];
  shift: {
    shiftName: string;
    goodCount: number;
    scrapCount: number;
    oee: number | null;
    availability: number;
    performance: number | null;
    quality: number | null;
    /** "HH:MM:SS" of the shift pattern, when the machine has one. */
    startTime?: string | null;
    endTime?: string | null;
    downSeconds?: number;
    downCount?: number;
  } | null;
  /** Parts in the last hour; the average cycle of the latest parts (null when no parts came lately). */
  rate: { partsLastHour: number; cycleSeconds: number | null; idealCycleSeconds: number | null };
  current: TerminalAssignment[];
  history: TerminalAssignment[];
  orders: Record<
    string,
    {
      progress: { goodCount: number; scrapCount: number; quantity: number; remaining: number; targetReached: boolean; operator: string | null; startedAt: string | null } | null;
      instruction: { partName: string; version: number; hasPdf: boolean } | null;
      quality: OrderQuality | null;
      plannedCycleSeconds: number | null;
    }
  >;
  faultCodes: { id: string; code: string; name: string }[];
  recentReports: { id: string; faultCode: string; faultName: string; status: string; reportedAt: string; reportedBy: string | null }[];
}

export interface OrderQuality {
  planVersion: number | null;
  firstPiece: { enabled: boolean; gatesCounting: boolean } | null;
  lastPiece: { enabled: boolean; gatesCompletion: boolean } | null;
  spot: { enabled: boolean; everyParts: number | null; maxMinutes: number | null } | null;
  lastPieceDone: boolean;
  /** Parts are not counted: the first piece is not measured yet, or a measurement failed. */
  hold: { checkId: string; kind: CheckKind; reason: "first_piece" | "failed"; since: string } | null;
  /** Open and failed checks of the order. */
  checks: QualityCheck[];
  lastClosed: QualityCheck | null;
}

export interface TerminalState {
  terminal: { id: string; name: string };
  machines: TerminalMachine[];
}

export interface Worker {
  ticket: string;
  expiresAt: number;
  name: string;
  roleName: string;
  permissions: string[];
}

export const terminalApi = {
  state: (id: string) => request<TerminalState>(id, "/state"),
  unlock: async (id: string, pin: string): Promise<Worker> => {
    const r = await request<{ ticket: string; expiresAt: number; worker: { name: string; roleName: string; permissions: string[] } }>(id, "/unlock", { method: "POST", body: { pin } });
    return { ticket: r.ticket, expiresAt: r.expiresAt, ...r.worker };
  },
  lock: (id: string, ticket: string) => request(id, "/lock", { method: "POST", body: {}, ticket }).catch(() => undefined),
  start: (id: string, ticket: string, workOrderId: string) =>
    request<{ workerExpiresAt: number }>(id, `/work-orders/${encodeURIComponent(workOrderId)}/start`, { method: "POST", body: {}, ticket }),
  complete: (id: string, ticket: string, workOrderId: string, skipLastPiece = false) =>
    request<{ workerExpiresAt: number }>(id, `/work-orders/${encodeURIComponent(workOrderId)}/complete`, { method: "POST", body: skipLastPiece ? { skipLastPiece: true } : {}, ticket }),
  qualityCheck: (id: string, checkId: string) => request<CheckDetail>(id, `/quality-checks/${encodeURIComponent(checkId)}`),
  measure: (id: string, ticket: string, checkId: string, body: { characteristicId: string; value?: number; ok?: boolean; comment?: string }) =>
    request<{ passed: boolean; status: string; check: CheckDetail; workerExpiresAt: number }>(id, `/quality-checks/${encodeURIComponent(checkId)}/measurements`, { method: "POST", body, ticket }),
  releaseCheck: (id: string, ticket: string, checkId: string, reason: string) =>
    request<{ workerExpiresAt: number }>(id, `/quality-checks/${encodeURIComponent(checkId)}/release`, { method: "POST", body: { reason }, ticket }),
  requestSpotCheck: (id: string, ticket: string, workOrderId: string) =>
    request<{ checkId: string; workerExpiresAt: number }>(id, `/work-orders/${encodeURIComponent(workOrderId)}/spot-check`, { method: "POST", body: {}, ticket }),
  reportFault: (id: string, ticket: string, machineId: string, faultCodeId: string) =>
    request<{ workerExpiresAt: number }>(id, "/fault-reports", { method: "POST", body: { machineId, faultCodeId }, ticket }),
  setStatus: (id: string, ticket: string, machineId: string, code: string) =>
    request<{ workerExpiresAt: number }>(id, `/machines/${encodeURIComponent(machineId)}/status`, { method: "POST", body: { code }, ticket }),
  endStatus: (id: string, ticket: string, machineId: string) =>
    request<{ workerExpiresAt: number }>(id, `/machines/${encodeURIComponent(machineId)}/status`, { method: "POST", body: { end: true }, ticket }),
  openInstruction: (id: string, ticket: string, workOrderId: string) =>
    request<{ instruction: WorkInstruction; workerExpiresAt: number }>(id, `/work-orders/${encodeURIComponent(workOrderId)}/instruction`, { method: "POST", body: {}, ticket }),
  fileSource: (id: string, fileId: string) => ({
    url: `${API_BASE}/api/terminal/${encodeURIComponent(id)}/instruction-files/${encodeURIComponent(fileId)}`,
    headers: { "X-Terminal-Token": readDeviceToken(id) ?? "" },
  }),
};
