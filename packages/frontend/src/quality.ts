/**
 * Minőségellenőrzés — közös típusok, feliratok és hívások a dashboard és a terminál számára.
 */
import { apiFetch, API_BASE } from "./api.js";
import { readJsonOrThrow } from "./master-data.js";
import { formatBytes, MAX_PDF_BYTES } from "./work-instructions.js";

export type CheckKind = "first_piece" | "last_piece" | "spot";
export type CheckStatus = "open" | "failed" | "passed" | "released" | "skipped" | "missed";
export type CharacteristicKind = "variable" | "attribute";

export interface Characteristic {
  id?: string;
  seq?: number;
  name: string;
  kind: CharacteristicKind;
  nominal: number | null;
  lowerLimit: number | null;
  upperLimit: number | null;
  unit: string | null;
  method: string | null;
  pdfFileId: string | null;
  pdfFileName: string | null;
  inFirstPiece: boolean;
  inLastPiece: boolean;
  inSpot: boolean;
}

export interface QualityPlan {
  id: string;
  partName: string;
  version: number;
  isCurrent: boolean;
  isActive: boolean;
  firstPiece: { enabled: boolean; gatesCounting: boolean };
  lastPiece: { enabled: boolean; gatesCompletion: boolean };
  spot: { enabled: boolean; everyParts: number | null; maxMinutes: number | null; graceMinutes: number };
  notes: string | null;
  createdByName: string | null;
  createdAt: string;
  characteristics: (Characteristic & { id: string; seq: number })[];
  openWorkOrders?: number;
}

export interface QualityCheck {
  id: string;
  workOrderId: string;
  orderNumber: string;
  partName: string;
  machineId: string | null;
  machineName: string | null;
  planId: string;
  planVersion: number;
  kind: CheckKind;
  trigger: string;
  gating: boolean;
  status: CheckStatus;
  holdSince: string | null;
  createdAt: string;
  closedAt: string | null;
  closedByName: string | null;
  releaseReason: string | null;
  total: number;
  passedCount: number;
  failedAttempts: number;
  overdue: boolean;
}

export interface Measurement {
  id: string;
  characteristicId: string;
  attempt: number;
  value: number | null;
  ok: boolean | null;
  passed: boolean;
  name: string;
  kind: CharacteristicKind;
  nominal: number | null;
  lowerLimit: number | null;
  upperLimit: number | null;
  unit: string | null;
  comment: string | null;
  measuredByName: string | null;
  terminalName: string | null;
  measuredAt: string;
}

export interface CheckDetail extends QualityCheck {
  items: (Characteristic & { id: string; seq: number; attempts: Measurement[]; passed: boolean })[];
  nextCharacteristicId: string | null;
}

export const KIND_LABEL: Record<CheckKind, string> = { first_piece: "First piece", last_piece: "Last piece", spot: "Spot check" };
export const KIND_LABEL_HU: Record<CheckKind, string> = { first_piece: "Első darab", last_piece: "Utolsó darab", spot: "Szúrópróba" };
export const STATUS_LABEL: Record<CheckStatus, string> = {
  open: "Open",
  failed: "Failed — on hold",
  passed: "Passed",
  released: "Released",
  skipped: "Skipped",
  missed: "Not done",
};
export const TRIGGER_LABEL: Record<string, string> = {
  start: "order started",
  complete: "order completion",
  parts: "part count",
  time: "time limit",
  manual: "requested",
};

export function statusTone(s: CheckStatus): "ok" | "alarm" | "warn" | "neutral" {
  return s === "passed" ? "ok" : s === "failed" || s === "missed" ? "alarm" : s === "released" || s === "skipped" ? "warn" : "neutral";
}

/** "9.95 … 10.05 mm", "≤ 1.6 µm", "OK / not OK". */
export function formatLimits(c: Pick<Characteristic, "kind" | "lowerLimit" | "upperLimit" | "unit">): string {
  if (c.kind === "attribute") return "OK / not OK";
  const u = c.unit ? ` ${c.unit}` : "";
  if (c.lowerLimit !== null && c.upperLimit !== null) return `${fmt(c.lowerLimit)} … ${fmt(c.upperLimit)}${u}`;
  if (c.upperLimit !== null) return `≤ ${fmt(c.upperLimit)}${u}`;
  if (c.lowerLimit !== null) return `≥ ${fmt(c.lowerLimit)}${u}`;
  return "—";
}

export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return String(Number(n.toPrecision(12)));
}

export function formatResult(m: Pick<Measurement, "kind" | "value" | "ok" | "unit">): string {
  if (m.kind === "attribute") return m.ok ? "OK" : "Not OK";
  return `${fmt(m.value)}${m.unit ? ` ${m.unit}` : ""}`;
}

export function listPlans(): Promise<QualityPlan[]> {
  return apiFetch(`${API_BASE}/api/quality-plans`).then((r) => readJsonOrThrow<QualityPlan[]>(r));
}

export function listPlanVersions(partName: string): Promise<QualityPlan[]> {
  return apiFetch(`${API_BASE}/api/quality-plans/${encodeURIComponent(partName)}/versions`).then((r) => readJsonOrThrow<QualityPlan[]>(r));
}

export function savePlan(body: unknown): Promise<QualityPlan> {
  return apiFetch(`${API_BASE}/api/quality-plans`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) =>
    readJsonOrThrow<QualityPlan>(r),
  );
}

export function archivePlan(partName: string): Promise<unknown> {
  return apiFetch(`${API_BASE}/api/quality-plans/${encodeURIComponent(partName)}/archive`, { method: "POST" }).then((r) => readJsonOrThrow(r));
}

export async function uploadPlanPdf(file: File): Promise<{ id: string; sizeBytes: number; fileName: string }> {
  const res = await apiFetch(`${API_BASE}/api/quality-plans/files`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent(file.name) },
    body: file,
  });
  if (res.status === 413) throw new Error(`The file is too large (limit ${formatBytes(MAX_PDF_BYTES)}).`);
  return readJsonOrThrow(res);
}

export function getCheckDetail(id: string): Promise<CheckDetail> {
  return apiFetch(`${API_BASE}/api/quality-checks/${encodeURIComponent(id)}`).then((r) => readJsonOrThrow<CheckDetail>(r));
}

export function listWorkOrderChecks(workOrderId: string): Promise<CheckDetail[]> {
  return apiFetch(`${API_BASE}/api/work-orders/${encodeURIComponent(workOrderId)}/quality-checks`).then((r) => readJsonOrThrow<CheckDetail[]>(r));
}

export function releaseCheck(id: string, reason: string): Promise<QualityCheck> {
  return apiFetch(`${API_BASE}/api/quality-checks/${encodeURIComponent(id)}/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  }).then((r) => readJsonOrThrow<QualityCheck>(r));
}

// ---------- SPC ----------

export type SignalRule = "beyond" | "run" | "trend";
export type CapabilityGrade = "capable" | "marginal" | "not_capable" | "unknown";

export interface SpcSummary {
  partName: string;
  name: string;
  unit: string | null;
  lsl: number | null;
  usl: number | null;
  nominal: number | null;
  n: number;
  mean: number | null;
  sigmaWithin: number | null;
  sigmaOverall: number | null;
  capability: { cp: number | null; cpk: number | null; pp: number | null; ppk: number | null };
  grade: CapabilityGrade;
  stable: boolean;
  reliable: boolean;
  outOfSpec: number;
  signalPoints: number;
  lastValue: number | null;
  lastAt: string | null;
}

export interface SpcPoint {
  id: string;
  at: string;
  value: number;
  mr: number | null;
  passed: boolean;
  lsl: number | null;
  usl: number | null;
  attempt: number;
  kind: CheckKind;
  checkId: string;
  workOrderId: string;
  orderNumber: string;
  machineName: string | null;
  measuredByName: string | null;
  signals: SignalRule[];
}

export interface SpcSeries {
  summary: SpcSummary;
  stats: { n: number; mean: number; sigmaOverall: number | null; mrBar: number | null; sigmaWithin: number | null; ucl: number | null; lcl: number | null; mrUcl: number | null };
  points: SpcPoint[];
  truncated: boolean;
  limitsChanged: boolean;
  planVersion: number | null;
}

export const GRADE_LABEL: Record<CapabilityGrade, string> = { capable: "Capable", marginal: "Marginal", not_capable: "Not capable", unknown: "—" };
export const SIGNAL_LABEL: Record<SignalRule, string> = {
  beyond: "beyond the control limits",
  run: "7 in a row on one side of the mean",
  trend: "6 in a row rising or falling",
};

export function spcQuery(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  return q.toString();
}

export function getSpcSummary(params: Record<string, string | undefined>): Promise<SpcSummary[]> {
  return apiFetch(`${API_BASE}/api/quality/spc?${spcQuery(params)}`).then((r) => readJsonOrThrow<SpcSummary[]>(r));
}

export function getSpcSeries(params: Record<string, string | undefined>): Promise<SpcSeries> {
  return apiFetch(`${API_BASE}/api/quality/spc/series?${spcQuery(params)}`).then((r) => readJsonOrThrow<SpcSeries>(r));
}

/** A capability index: two decimals, "—" when there is none. */
export function fmtIndex(v: number | null): string {
  return v === null || !Number.isFinite(v) ? "—" : v.toFixed(2);
}

/** A measured value with enough decimals for its spread. */
export function fmtValue(v: number | null, digits = 4): string {
  return v === null || !Number.isFinite(v) ? "—" : String(Number(v.toFixed(digits)));
}
