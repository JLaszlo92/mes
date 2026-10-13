import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./db.js";
import {
  evaluateMeasurement,
  includedIn,
  nextCharacteristic,
  spotDue,
  type CharacteristicInput,
  type CharacteristicKind,
  type CheckKind,
  type PlanInput,
} from "./quality-input.js";

/**
 * Minőségellenőrzés: tervek (part-onként verziózva), ellenőrzések és mérések.
 *
 * Szabályok röviden (részletesen: docs/DEVELOPMENT_STATUS.md, "Quality"):
 * - Első darab: a rendelés indításakor nyílik. Ha a terv így kéri
 *   (gatesCounting), a gép darabjai addig nem számítanak, amíg át nem megy
 *   (vagy egy quality supervisor fel nem oldja).
 * - Utolsó darab: a lezárás kérésekor nyílik. Ha a terv így kéri
 *   (gatesCompletion), a rendelés csak utána zárható le.
 * - Szúrópróba: N darabonként és/vagy legkésőbb X percenként nyílik.
 *   Lejárt (grace idő után is nyitott) szúrópróba riasztást ad, de nem tilt.
 * - Bármelyik ellenőrzés tűrésen kívüli mérése tiltja a darabszámlálást,
 *   amíg egy újramérés meg nem felel, vagy a supervisor fel nem oldja.
 * - Egyszerre egy mérés: a sorrendben következő jellemző (a hibás addig
 *   marad soron, amíg meg nem felel).
 */

export class QualityError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ---------- plans ----------

export interface Characteristic extends CharacteristicInput {
  id: string;
  seq: number;
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
  characteristics: Characteristic[];
}

type PlanRow = {
  id: string;
  part_name: string;
  version: number;
  is_current: boolean;
  is_active: boolean;
  first_piece_enabled: boolean;
  first_piece_gates_counting: boolean;
  last_piece_enabled: boolean;
  last_piece_gates_completion: boolean;
  spot_enabled: boolean;
  spot_every_parts: number | null;
  spot_max_minutes: number | null;
  spot_grace_minutes: number;
  notes: string | null;
  created_by_name: string | null;
  created_at: Date;
};

type CharRow = {
  id: string;
  plan_id: string;
  seq: number;
  name: string;
  kind: CharacteristicKind;
  nominal: string | null;
  lower_limit: string | null;
  upper_limit: string | null;
  unit: string | null;
  method: string | null;
  pdf_file_id: string | null;
  pdf_file_name: string | null;
  in_first_piece: boolean;
  in_last_piece: boolean;
  in_spot: boolean;
};

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

function toChar(r: CharRow): Characteristic {
  return {
    id: r.id,
    seq: r.seq,
    name: r.name,
    kind: r.kind,
    nominal: num(r.nominal),
    lowerLimit: num(r.lower_limit),
    upperLimit: num(r.upper_limit),
    unit: r.unit,
    method: r.method,
    pdfFileId: r.pdf_file_id,
    pdfFileName: r.pdf_file_name,
    inFirstPiece: r.in_first_piece,
    inLastPiece: r.in_last_piece,
    inSpot: r.in_spot,
  };
}

function toPlan(r: PlanRow, chars: Characteristic[]): QualityPlan {
  return {
    id: r.id,
    partName: r.part_name,
    version: r.version,
    isCurrent: r.is_current,
    isActive: r.is_active,
    firstPiece: { enabled: r.first_piece_enabled, gatesCounting: r.first_piece_gates_counting },
    lastPiece: { enabled: r.last_piece_enabled, gatesCompletion: r.last_piece_gates_completion },
    spot: { enabled: r.spot_enabled, everyParts: r.spot_every_parts, maxMinutes: r.spot_max_minutes, graceMinutes: r.spot_grace_minutes },
    notes: r.notes,
    createdByName: r.created_by_name,
    createdAt: new Date(r.created_at).toISOString(),
    characteristics: chars,
  };
}

const PLAN_SELECT = `
  SELECT p.*, COALESCE(u.display_name, u.email) AS created_by_name
  FROM quality_plans p LEFT JOIN users u ON u.id = p.created_by`;

async function withCharacteristics(rows: PlanRow[], db: Pick<PoolClient, "query"> = pool): Promise<QualityPlan[]> {
  if (rows.length === 0) return [];
  const chars = await db.query<CharRow>(`SELECT * FROM quality_characteristics WHERE plan_id = ANY($1) ORDER BY plan_id, seq`, [rows.map((r) => r.id)]);
  return rows.map((r) => toPlan(r, chars.rows.filter((c) => c.plan_id === r.id).map(toChar)));
}

export interface PlanSummary extends QualityPlan {
  openWorkOrders: number;
}

/** The current version of every part's plan (archived ones too, flagged), with the number of open orders of the part. */
export async function listCurrentPlans(): Promise<PlanSummary[]> {
  const result = await pool.query<PlanRow & { open_work_orders: string }>(
    `${PLAN_SELECT.replace("SELECT p.*,", "SELECT p.*, (SELECT count(*) FROM work_orders wo WHERE wo.part_name = p.part_name AND wo.status NOT IN ('completed', 'cancelled')) AS open_work_orders,")}
     WHERE p.is_current ORDER BY p.part_name`,
  );
  const plans = await withCharacteristics(result.rows);
  return plans.map((p, i) => ({ ...p, openWorkOrders: Number(result.rows[i]!.open_work_orders) }));
}

export async function getPlan(id: string): Promise<QualityPlan | undefined> {
  const result = await pool.query<PlanRow>(`${PLAN_SELECT} WHERE p.id = $1`, [id]);
  return (await withCharacteristics(result.rows))[0];
}

/** The plan that applies to a part now: the current version, if not archived. */
export async function getActivePlanForPart(partName: string, db: Pick<PoolClient, "query"> = pool): Promise<QualityPlan | undefined> {
  const result = await db.query<PlanRow>(`${PLAN_SELECT} WHERE p.part_name = $1 AND p.is_current AND p.is_active`, [partName.trim()]);
  return (await withCharacteristics(result.rows, db))[0];
}

export async function listPlanVersions(partName: string): Promise<QualityPlan[]> {
  const result = await pool.query<PlanRow>(`${PLAN_SELECT} WHERE p.part_name = $1 ORDER BY p.version DESC`, [partName]);
  return withCharacteristics(result.rows);
}

/** Saving a plan always makes a new version; earlier versions stay, so recorded checks keep pointing at what was measured. */
export async function createPlanVersion(input: PlanInput, userId: string): Promise<QualityPlan> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('quality_plan:' || $1))`, [input.partName]);
    const last = await client.query<{ version: number }>(`SELECT COALESCE(max(version), 0) AS version FROM quality_plans WHERE part_name = $1`, [input.partName]);
    const version = (last.rows[0]?.version ?? 0) + 1;
    await client.query(`UPDATE quality_plans SET is_current = false WHERE part_name = $1 AND is_current`, [input.partName]);
    const id = randomUUID();
    await client.query(
      `INSERT INTO quality_plans (id, part_name, version, first_piece_enabled, first_piece_gates_counting, last_piece_enabled, last_piece_gates_completion,
                                  spot_enabled, spot_every_parts, spot_max_minutes, spot_grace_minutes, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        input.partName,
        version,
        input.firstPiece.enabled,
        input.firstPiece.gatesCounting,
        input.lastPiece.enabled,
        input.lastPiece.gatesCompletion,
        input.spot.enabled,
        input.spot.everyParts,
        input.spot.maxMinutes,
        input.spot.graceMinutes,
        input.notes,
        userId,
      ],
    );
    for (const [i, c] of input.characteristics.entries()) {
      await client.query(
        `INSERT INTO quality_characteristics (id, plan_id, seq, name, kind, nominal, lower_limit, upper_limit, unit, method, pdf_file_id, pdf_file_name,
                                              in_first_piece, in_last_piece, in_spot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [randomUUID(), id, i + 1, c.name, c.kind, c.nominal, c.lowerLimit, c.upperLimit, c.unit, c.method, c.pdfFileId, c.pdfFileName, c.inFirstPiece, c.inLastPiece, c.inSpot],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return (await getActivePlanForPart(input.partName))!;
}

/** The part has no quality plan any more (the versions stay for the records). */
export async function archivePlan(partName: string): Promise<boolean> {
  const result = await pool.query(`UPDATE quality_plans SET is_active = false WHERE part_name = $1 AND is_current AND is_active`, [partName]);
  return (result.rowCount ?? 0) > 0;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23503";
}

// ---------- checks ----------

export type CheckStatus = "open" | "failed" | "passed" | "released" | "skipped" | "missed";
export const ACTIVE_STATUSES: readonly CheckStatus[] = ["open", "failed"];

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
  /** Characteristics in this check, those whose latest attempt passed, and failed attempts so far. */
  total: number;
  passedCount: number;
  failedAttempts: number;
  /** An active spot check older than the plan's grace time. */
  overdue: boolean;
}

type CheckRow = {
  id: string;
  work_order_id: string;
  order_number: string;
  part_name: string;
  machine_id: string | null;
  machine_name: string | null;
  plan_id: string;
  plan_version: number;
  kind: CheckKind;
  trigger: string;
  gating: boolean;
  status: CheckStatus;
  hold_since: Date | null;
  created_at: Date;
  closed_at: Date | null;
  closed_by_name: string | null;
  release_reason: string | null;
  total: string;
  passed_count: string;
  failed_attempts: string;
  overdue: boolean;
};

const CHECK_SELECT = `
  SELECT qc.*, wo.order_number, wo.part_name, m.name AS machine_name, p.version AS plan_version,
         (SELECT count(*) FROM quality_characteristics c WHERE c.plan_id = qc.plan_id
            AND CASE qc.kind WHEN 'first_piece' THEN c.in_first_piece WHEN 'last_piece' THEN c.in_last_piece ELSE c.in_spot END) AS total,
         (SELECT count(*) FROM (SELECT DISTINCT ON (qm.characteristic_id) qm.passed FROM quality_measurements qm
            WHERE qm.check_id = qc.id ORDER BY qm.characteristic_id, qm.attempt DESC) latest WHERE latest.passed) AS passed_count,
         (SELECT count(*) FROM quality_measurements qm WHERE qm.check_id = qc.id AND NOT qm.passed) AS failed_attempts,
         (qc.kind = 'spot' AND qc.status IN ('open', 'failed') AND qc.created_at < now() - make_interval(mins => p.spot_grace_minutes)) AS overdue
  FROM quality_checks qc
  JOIN work_orders wo ON wo.id = qc.work_order_id
  JOIN quality_plans p ON p.id = qc.plan_id
  LEFT JOIN machines m ON m.id = qc.machine_id`;

function toCheck(r: CheckRow): QualityCheck {
  return {
    id: r.id,
    workOrderId: r.work_order_id,
    orderNumber: r.order_number,
    partName: r.part_name,
    machineId: r.machine_id,
    machineName: r.machine_name,
    planId: r.plan_id,
    planVersion: r.plan_version,
    kind: r.kind,
    trigger: r.trigger,
    gating: r.gating,
    status: r.status,
    holdSince: r.hold_since ? new Date(r.hold_since).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
    closedByName: r.closed_by_name,
    releaseReason: r.release_reason,
    total: Number(r.total),
    passedCount: Number(r.passed_count),
    failedAttempts: Number(r.failed_attempts),
    overdue: r.overdue,
  };
}

export interface CheckFilter {
  q?: string;
  status?: CheckStatus | "active";
  kind?: CheckKind;
  workOrderId?: string;
  machineIds?: string[];
  limit: number;
  offset: number;
}

export async function listChecksPage(f: CheckFilter): Promise<{ rows: QualityCheck[]; total: number }> {
  const where: string[] = [];
  const args: unknown[] = [];
  const arg = (v: unknown) => {
    args.push(v);
    return `$${args.length}`;
  };
  if (f.q) where.push(`(wo.order_number ILIKE ${arg(`%${f.q}%`)} OR wo.part_name ILIKE $${args.length} OR m.name ILIKE $${args.length})`);
  if (f.status === "active") where.push(`qc.status IN ('open', 'failed')`);
  else if (f.status) where.push(`qc.status = ${arg(f.status)}`);
  if (f.kind) where.push(`qc.kind = ${arg(f.kind)}`);
  if (f.workOrderId) where.push(`qc.work_order_id = ${arg(f.workOrderId)}`);
  if (f.machineIds) where.push(`qc.machine_id = ANY(${arg(f.machineIds)})`);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const count = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM quality_checks qc JOIN work_orders wo ON wo.id = qc.work_order_id LEFT JOIN machines m ON m.id = qc.machine_id ${clause}`,
    args,
  );
  const rows = await pool.query<CheckRow>(`${CHECK_SELECT} ${clause} ORDER BY qc.created_at DESC, qc.id LIMIT ${arg(f.limit)} OFFSET ${arg(f.offset)}`, args);
  return { rows: rows.rows.map(toCheck), total: Number(count.rows[0]?.n ?? 0) };
}

export async function getCheck(id: string, db: Pick<PoolClient, "query"> = pool): Promise<QualityCheck | undefined> {
  const result = await db.query<CheckRow>(`${CHECK_SELECT} WHERE qc.id = $1`, [id]);
  return result.rows[0] ? toCheck(result.rows[0]) : undefined;
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

type MeasurementRow = {
  id: string;
  characteristic_id: string;
  attempt: number;
  value: string | null;
  ok: boolean | null;
  passed: boolean;
  name: string;
  kind: CharacteristicKind;
  nominal: string | null;
  lower_limit: string | null;
  upper_limit: string | null;
  unit: string | null;
  comment: string | null;
  measured_by_name: string | null;
  terminal_name: string | null;
  measured_at: Date;
};

function toMeasurement(r: MeasurementRow): Measurement {
  return {
    id: r.id,
    characteristicId: r.characteristic_id,
    attempt: r.attempt,
    value: num(r.value),
    ok: r.ok,
    passed: r.passed,
    name: r.name,
    kind: r.kind,
    nominal: num(r.nominal),
    lowerLimit: num(r.lower_limit),
    upperLimit: num(r.upper_limit),
    unit: r.unit,
    comment: r.comment,
    measuredByName: r.measured_by_name,
    terminalName: r.terminal_name,
    measuredAt: new Date(r.measured_at).toISOString(),
  };
}

export interface CheckDetail extends QualityCheck {
  /** The characteristics of this check in order, each with every attempt. */
  items: (Characteristic & { attempts: Measurement[]; passed: boolean })[];
  /** The one to measure now (active checks only). */
  nextCharacteristicId: string | null;
}

async function checkCharacteristics(check: Pick<QualityCheck, "planId" | "kind">, db: Pick<PoolClient, "query"> = pool): Promise<Characteristic[]> {
  const result = await db.query<CharRow>(`SELECT * FROM quality_characteristics WHERE plan_id = $1 ORDER BY seq`, [check.planId]);
  return result.rows.map(toChar).filter((c) => includedIn(check.kind, c));
}

export async function getCheckDetail(id: string): Promise<CheckDetail | undefined> {
  const check = await getCheck(id);
  if (!check) return undefined;
  const chars = await checkCharacteristics(check);
  const measurements = await pool.query<MeasurementRow>(`SELECT * FROM quality_measurements WHERE check_id = $1 ORDER BY measured_at, attempt`, [id]);
  const all = measurements.rows.map(toMeasurement);
  const items = chars.map((c) => {
    const attempts = all.filter((m) => m.characteristicId === c.id);
    return { ...c, attempts, passed: attempts.at(-1)?.passed === true };
  });
  const active = ACTIVE_STATUSES.includes(check.status);
  const next = active ? nextCharacteristic(items, new Map(items.map((i) => [i.id, i.passed]))) : undefined;
  return { ...check, items, nextCharacteristicId: next?.id ?? null };
}

export async function listChecksForWorkOrder(workOrderId: string): Promise<CheckDetail[]> {
  const ids = await pool.query<{ id: string }>(`SELECT id FROM quality_checks WHERE work_order_id = $1 ORDER BY created_at`, [workOrderId]);
  const details = await Promise.all(ids.rows.map((r) => getCheckDetail(r.id)));
  return details.filter((d): d is CheckDetail => d !== undefined);
}

// ---------- the engine ----------

/** When the order was started (the first in_progress change in the audit log, as computeWorkOrderProgress reads it). */
async function startedAt(workOrderId: string): Promise<Date | null> {
  const result = await pool.query<{ occurred_at: Date }>(
    `SELECT occurred_at FROM audit_log WHERE action = 'work_order_updated' AND target = $1 AND details->>'status' = 'in_progress' ORDER BY occurred_at LIMIT 1`,
    [workOrderId],
  );
  return result.rows[0]?.occurred_at ?? null;
}

async function machineOf(workOrderId: string): Promise<string | null> {
  const result = await pool.query<{ machine_id: string }>(`SELECT machine_id FROM work_order_assignments WHERE work_order_id = $1 ORDER BY planned_start LIMIT 1`, [workOrderId]);
  return result.rows[0]?.machine_id ?? null;
}

async function partOf(workOrderId: string): Promise<string | undefined> {
  const result = await pool.query<{ part_name: string }>(`SELECT part_name FROM work_orders WHERE id = $1`, [workOrderId]);
  return result.rows[0]?.part_name;
}

/**
 * Opens a check of this kind for the order if its plan has one and none is active yet. Returns the active check's id
 * (new or existing), or undefined if the plan has no such check.
 */
export async function ensureCheck(input: { workOrderId: string; kind: CheckKind; trigger: "start" | "complete" | "parts" | "time" | "manual"; machineId?: string | null }): Promise<string | undefined> {
  const part = await partOf(input.workOrderId);
  if (part === undefined) return undefined;
  const plan = await getActivePlanForPart(part);
  if (!plan) return undefined;
  const enabled = input.kind === "first_piece" ? plan.firstPiece.enabled : input.kind === "last_piece" ? plan.lastPiece.enabled : plan.spot.enabled || input.trigger === "manual";
  if (!enabled || !plan.characteristics.some((c) => includedIn(input.kind, c))) return undefined;
  const gating = input.kind === "first_piece" ? plan.firstPiece.gatesCounting : input.kind === "last_piece" ? plan.lastPiece.gatesCompletion : false;
  const machineId = input.machineId ?? (await machineOf(input.workOrderId));
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO quality_checks (id, work_order_id, machine_id, plan_id, kind, trigger, gating, hold_since)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN now() END)
     ON CONFLICT (work_order_id, kind) WHERE status IN ('open', 'failed') DO NOTHING
     RETURNING id`,
    [randomUUID(), input.workOrderId, machineId, plan.id, input.kind, input.trigger, gating, input.kind === "first_piece" && gating],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = await pool.query<{ id: string }>(`SELECT id FROM quality_checks WHERE work_order_id = $1 AND kind = $2 AND status IN ('open', 'failed')`, [input.workOrderId, input.kind]);
  return existing.rows[0]?.id;
}

/** The order was started: the first-piece check opens (once per order). */
export async function onWorkOrderStarted(workOrderId: string, machineId?: string | null): Promise<string | undefined> {
  const done = await pool.query(`SELECT 1 FROM quality_checks WHERE work_order_id = $1 AND kind = 'first_piece' LIMIT 1`, [workOrderId]);
  if (done.rowCount) return undefined;
  return ensureCheck({ workOrderId, kind: "first_piece", trigger: "start", machineId });
}

export type LastPieceGate = { ok: true } | { ok: false; gating: boolean; checkId: string };

/**
 * Before completing: if the plan has a last-piece check and it has not passed (or been released or skipped), it is
 * opened and the answer says whether completion has to wait for it (gating) or may skip it.
 */
export async function lastPieceGate(workOrderId: string, machineId?: string | null): Promise<LastPieceGate> {
  const closed = await pool.query(`SELECT 1 FROM quality_checks WHERE work_order_id = $1 AND kind = 'last_piece' AND status IN ('passed', 'released', 'skipped') LIMIT 1`, [workOrderId]);
  if (closed.rowCount) return { ok: true };
  const checkId = await ensureCheck({ workOrderId, kind: "last_piece", trigger: "complete", machineId });
  if (!checkId) return { ok: true };
  const check = await getCheck(checkId);
  return { ok: false, gating: check?.gating ?? true, checkId };
}

/** The order is closed: checks still open were not done. */
export async function onWorkOrderClosed(workOrderId: string): Promise<number> {
  const result = await pool.query(`UPDATE quality_checks SET status = 'missed', closed_at = now() WHERE work_order_id = $1 AND status IN ('open', 'failed')`, [workOrderId]);
  return result.rowCount ?? 0;
}

export interface Hold {
  checkId: string;
  kind: CheckKind;
  reason: "first_piece" | "failed";
  since: string;
}

/** Does a quality check hold the part count of this machine (a running order's gating first piece, or a failed check)? */
export async function holdForMachine(machineId: string): Promise<Hold | undefined> {
  const result = await pool.query<{ id: string; kind: CheckKind; status: CheckStatus; since: Date }>(
    `SELECT qc.id, qc.kind, qc.status, COALESCE(qc.hold_since, qc.created_at) AS since
     FROM quality_checks qc JOIN work_orders wo ON wo.id = qc.work_order_id
     WHERE qc.machine_id = $1 AND wo.status = 'in_progress'
       AND (qc.status = 'failed' OR (qc.status = 'open' AND qc.kind = 'first_piece' AND qc.gating))
     ORDER BY since LIMIT 1`,
    [machineId],
  );
  const r = result.rows[0];
  return r ? { checkId: r.id, kind: r.kind, reason: r.status === "failed" ? "failed" : "first_piece", since: new Date(r.since).toISOString() } : undefined;
}

export interface MeasurementResult {
  passed: boolean;
  status: CheckStatus;
  attempt: number;
  nextCharacteristicId: string | null;
}

/** One measurement of the characteristic that is next in the check. */
export async function recordMeasurement(input: {
  checkId: string;
  characteristicId: string;
  value?: number | null;
  ok?: boolean | null;
  comment?: string | null;
  userId: string;
  userName: string;
  terminalId?: string | null;
  terminalName?: string | null;
}): Promise<MeasurementResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ status: CheckStatus; plan_id: string; kind: CheckKind; gating: boolean }>(
      `SELECT status, plan_id, kind, gating FROM quality_checks WHERE id = $1 FOR UPDATE`,
      [input.checkId],
    );
    const check = locked.rows[0];
    if (!check) throw new QualityError(404, "unknown_check", "unknown quality check");
    if (!ACTIVE_STATUSES.includes(check.status)) throw new QualityError(409, "check_closed", "this check is already closed");
    const chars = await checkCharacteristics({ planId: check.plan_id, kind: check.kind }, client);
    const latest = await client.query<{ characteristic_id: string; passed: boolean; attempt: number }>(
      `SELECT DISTINCT ON (characteristic_id) characteristic_id, passed, attempt FROM quality_measurements WHERE check_id = $1 ORDER BY characteristic_id, attempt DESC`,
      [input.checkId],
    );
    const passedMap = new Map(latest.rows.map((r) => [r.characteristic_id, r.passed]));
    const next = nextCharacteristic(chars, passedMap);
    if (!next) throw new QualityError(409, "check_complete", "every measurement of this check is done");
    if (next.id !== input.characteristicId) throw new QualityError(409, "out_of_order", `measure "${next.name}" first`);
    if (next.kind === "variable" && (typeof input.value !== "number" || !Number.isFinite(input.value))) throw new QualityError(400, "value_required", "enter the measured value");
    if (next.kind === "attribute" && typeof input.ok !== "boolean") throw new QualityError(400, "ok_required", "choose OK or not OK");
    const passed = evaluateMeasurement(next, { value: input.value, ok: input.ok });
    const attempt = (latest.rows.find((r) => r.characteristic_id === next.id)?.attempt ?? 0) + 1;
    await client.query(
      `INSERT INTO quality_measurements (id, check_id, characteristic_id, attempt, value, ok, passed, name, kind, nominal, lower_limit, upper_limit, unit, comment,
                                         measured_by, measured_by_name, terminal_id, terminal_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        randomUUID(),
        input.checkId,
        next.id,
        attempt,
        next.kind === "variable" ? input.value : null,
        next.kind === "attribute" ? input.ok : null,
        passed,
        next.name,
        next.kind,
        next.nominal,
        next.lowerLimit,
        next.upperLimit,
        next.unit,
        input.comment ?? null,
        input.userId,
        input.userName,
        input.terminalId ?? null,
        input.terminalName ?? null,
      ],
    );
    passedMap.set(next.id, passed);
    const after = nextCharacteristic(chars, passedMap);
    let status: CheckStatus;
    if (!passed) {
      status = "failed";
      await client.query(`UPDATE quality_checks SET status = 'failed', hold_since = COALESCE(hold_since, now()) WHERE id = $1`, [input.checkId]);
    } else if (!after) {
      status = "passed";
      await client.query(`UPDATE quality_checks SET status = 'passed', closed_at = now(), closed_by = $2, closed_by_name = $3 WHERE id = $1`, [input.checkId, input.userId, input.userName]);
    } else {
      status = "open";
      // The failure is measured again and passed: only a gating first piece still holds the count.
      await client.query(`UPDATE quality_checks SET status = 'open', hold_since = CASE WHEN kind = 'first_piece' AND gating THEN hold_since END WHERE id = $1`, [input.checkId]);
    }
    await client.query("COMMIT");
    return { passed, status, attempt, nextCharacteristicId: status === "passed" ? null : (after?.id ?? null) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** A quality supervisor lets the process go on without (or despite) the measurement; the reason is kept. */
export async function releaseCheck(checkId: string, reason: string, user: { id: string; name: string }): Promise<QualityCheck> {
  const result = await pool.query(
    `UPDATE quality_checks SET status = 'released', closed_at = now(), closed_by = $2, closed_by_name = $3, release_reason = $4
     WHERE id = $1 AND status IN ('open', 'failed')`,
    [checkId, user.id, user.name, reason],
  );
  if (!result.rowCount) {
    const exists = await getCheck(checkId);
    if (!exists) throw new QualityError(404, "unknown_check", "unknown quality check");
    throw new QualityError(409, "check_closed", "this check is already closed");
  }
  return (await getCheck(checkId))!;
}

/** A non-gating last-piece check left out on purpose at completion. */
export async function skipCheck(checkId: string, user: { id: string; name: string }): Promise<void> {
  const result = await pool.query(
    `UPDATE quality_checks SET status = 'skipped', closed_at = now(), closed_by = $2, closed_by_name = $3
     WHERE id = $1 AND status IN ('open', 'failed') AND NOT gating`,
    [checkId, user.id, user.name],
  );
  if (!result.rowCount) throw new QualityError(409, "cannot_skip", "this check cannot be skipped");
}

/** Running orders on a machine (with their part). */
async function runningOrders(machineId?: string): Promise<{ workOrderId: string; partName: string; machineId: string }[]> {
  const result = await pool.query<{ id: string; part_name: string; machine_id: string }>(
    `SELECT DISTINCT wo.id, wo.part_name, woa.machine_id FROM work_orders wo JOIN work_order_assignments woa ON woa.work_order_id = wo.id
     WHERE wo.status = 'in_progress' ${machineId ? "AND woa.machine_id = $1" : ""}`,
    machineId ? [machineId] : [],
  );
  return result.rows.map((r) => ({ workOrderId: r.id, partName: r.part_name, machineId: r.machine_id }));
}

/**
 * Opens a spot check where one is due: N parts since the last one (or the start), or the longest time is up.
 * Called after counted parts and by the evaluator. Returns the opened checks.
 */
export async function raiseDueSpotChecks(machineId?: string, now = new Date()): Promise<{ workOrderId: string; checkId: string; trigger: "parts" | "time" }[]> {
  const opened: { workOrderId: string; checkId: string; trigger: "parts" | "time" }[] = [];
  for (const order of await runningOrders(machineId)) {
    const plan = await getActivePlanForPart(order.partName);
    if (!plan?.spot.enabled || !plan.characteristics.some((c) => c.inSpot)) continue;
    // Not while the first piece is still being checked; counting from its end, the last spot check, or the start.
    const state = await pool.query<{ active: boolean; first_active: boolean; last: Date | null; first_closed: Date | null }>(
      `SELECT bool_or(kind = 'spot' AND status IN ('open', 'failed')) AS active,
              bool_or(kind = 'first_piece' AND status IN ('open', 'failed')) AS first_active,
              max(created_at) FILTER (WHERE kind = 'spot') AS last,
              max(closed_at) FILTER (WHERE kind = 'first_piece') AS first_closed
       FROM quality_checks WHERE work_order_id = $1`,
      [order.workOrderId],
    );
    if (state.rows[0]?.active || state.rows[0]?.first_active) continue;
    const start = await startedAt(order.workOrderId);
    if (!start) continue;
    const anchor = [start, state.rows[0]?.last ?? null, state.rows[0]?.first_closed ?? null]
      .filter((d): d is Date => d !== null)
      .reduce((a, b) => (b > a ? b : a));
    let parts = 0;
    if (plan.spot.everyParts !== null) {
      const counted = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM events WHERE machine_id = $1 AND type = 'production_count' AND "timestamp" >= $2`,
        [order.machineId, anchor],
      );
      parts = Number(counted.rows[0]?.n ?? 0);
    }
    const due = spotDue({ spotEnabled: true, spotEveryParts: plan.spot.everyParts, spotMaxMinutes: plan.spot.maxMinutes }, anchor, parts, now);
    if (!due) continue;
    const checkId = await ensureCheck({ workOrderId: order.workOrderId, kind: "spot", trigger: due, machineId: order.machineId });
    if (checkId) opened.push({ workOrderId: order.workOrderId, checkId, trigger: due });
  }
  return opened;
}

/** Active spot checks past their grace time (for the alert). */
export async function listOverdueChecks(): Promise<QualityCheck[]> {
  const result = await pool.query<CheckRow>(`${CHECK_SELECT} WHERE qc.kind = 'spot' AND qc.status IN ('open', 'failed') AND qc.created_at < now() - make_interval(mins => p.spot_grace_minutes) ORDER BY qc.created_at`);
  return result.rows.map(toCheck);
}

/** What the terminal needs about a running order's quality. */
export async function orderQuality(workOrderId: string, partName: string, machineId: string) {
  const plan = await getActivePlanForPart(partName);
  const active = await pool.query<CheckRow>(`${CHECK_SELECT} WHERE qc.work_order_id = $1 AND qc.status IN ('open', 'failed') ORDER BY qc.created_at`, [workOrderId]);
  const hold = await holdForMachine(machineId);
  const lastDone = await pool.query(`SELECT 1 FROM quality_checks WHERE work_order_id = $1 AND kind = 'last_piece' AND status IN ('passed', 'released', 'skipped') LIMIT 1`, [workOrderId]);
  const closed = await pool.query<CheckRow>(`${CHECK_SELECT} WHERE qc.work_order_id = $1 AND qc.status NOT IN ('open', 'failed') ORDER BY qc.closed_at DESC NULLS LAST LIMIT 1`, [workOrderId]);
  if (!plan && active.rows.length === 0) return null;
  return {
    planVersion: plan?.version ?? null,
    firstPiece: plan?.firstPiece ?? null,
    lastPiece: plan?.lastPiece ?? null,
    spot: plan?.spot ?? null,
    lastPieceDone: (lastDone.rowCount ?? 0) > 0,
    hold: hold && active.rows.some((r) => r.id === hold.checkId) ? hold : null,
    checks: active.rows.map(toCheck),
    /** The latest closed check of the order (for "first piece passed at 18:09"). */
    lastClosed: closed.rows[0] ? toCheck(closed.rows[0]) : null,
  };
}
