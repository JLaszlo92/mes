import { randomUUID } from "node:crypto";
import type { MachineEvent } from "@mes/shared";
import { pool } from "./db.js";
import { goodCountSql } from "./count-sql.js";
import { listRuns, liveCounts, type ScrapLine } from "./work-order-runs.js";
import { insertEvent } from "./events-repository.js";
import { publishToHub } from "./hub.js";
import { stateStore } from "./state.js";

/**
 * Selejtokok (Admin → Scrap reasons, mint a Status definitions: globális és
 * gépenkénti sorok) és a terminálon lejelentett selejt. A lejelentés egy
 * scrap_bookings sor (ki, mikor, mennyit, milyen okkal, melyik rendelésre)
 * plusz darabonként egy production_count esemény (result = scrap,
 * scrapReasonCode), így minden összesítő látja; "reclassify" módú gépen az
 * esemény reclassified = true, és a jó darabból levonódik (count-sql.ts).
 */

export type ScrapMode = "reclassify" | "additional";
export const SCRAP_MODES: readonly ScrapMode[] = ["reclassify", "additional"];

export interface ScrapReason {
  id: string;
  machineId: string | null;
  code: string;
  name: string;
  isActive: boolean;
}

type ReasonRow = { id: string; machine_id: string | null; code: string; name: string; is_active: boolean };
const toReason = (r: ReasonRow): ScrapReason => ({ id: r.id, machineId: r.machine_id, code: r.code, name: r.name, isActive: r.is_active });

export async function listScrapReasons(): Promise<ScrapReason[]> {
  const result = await pool.query<ReasonRow>(`SELECT * FROM scrap_reasons ORDER BY machine_id NULLS FIRST, code`);
  return result.rows.map(toReason);
}

/** The reasons a worker may choose on a machine: its own, then the global ones it does not override; active only. */
export function reasonsForMachine(all: readonly ScrapReason[], machineId: string): ScrapReason[] {
  const own = all.filter((r) => r.machineId === machineId);
  const global = all.filter((r) => r.machineId === null && !own.some((o) => o.code === r.code));
  return [...own, ...global].filter((r) => r.isActive);
}

export async function createScrapReason(input: { machineId?: string | null; code: string; name: string }): Promise<ScrapReason> {
  const result = await pool.query<ReasonRow>(`INSERT INTO scrap_reasons (id, machine_id, code, name) VALUES ($1, $2, $3, $4) RETURNING *`, [
    randomUUID(),
    input.machineId ?? null,
    input.code,
    input.name,
  ]);
  return toReason(result.rows[0]!);
}

export async function updateScrapReason(id: string, input: { name?: string; isActive?: boolean }): Promise<{ before: ScrapReason; after: ScrapReason } | undefined> {
  const current = await pool.query<ReasonRow>(`SELECT * FROM scrap_reasons WHERE id = $1`, [id]);
  if (!current.rows[0]) return undefined;
  const before = toReason(current.rows[0]);
  const result = await pool.query<ReasonRow>(`UPDATE scrap_reasons SET name = $2, is_active = $3 WHERE id = $1 RETURNING *`, [id, input.name ?? before.name, input.isActive ?? before.isActive]);
  return { before, after: toReason(result.rows[0]!) };
}

export async function deleteScrapReason(id: string): Promise<boolean> {
  const result = await pool.query(`DELETE FROM scrap_reasons WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function listScrapModes(): Promise<{ machineId: string; machineName: string; mode: ScrapMode; isActive: boolean }[]> {
  const result = await pool.query<{ id: string; name: string; scrap_booking_mode: ScrapMode; is_active: boolean }>(
    `SELECT id, name, scrap_booking_mode, is_active FROM machines ORDER BY name`,
  );
  return result.rows.map((r) => ({ machineId: r.id, machineName: r.name, mode: r.scrap_booking_mode, isActive: r.is_active }));
}

export async function getScrapMode(machineId: string): Promise<ScrapMode | undefined> {
  const result = await pool.query<{ scrap_booking_mode: ScrapMode }>(`SELECT scrap_booking_mode FROM machines WHERE id = $1`, [machineId]);
  return result.rows[0]?.scrap_booking_mode;
}

export async function setScrapMode(machineId: string, mode: ScrapMode): Promise<{ from: ScrapMode } | undefined> {
  const before = await getScrapMode(machineId);
  if (!before) return undefined;
  await pool.query(`UPDATE machines SET scrap_booking_mode = $2 WHERE id = $1`, [machineId, mode]);
  return { from: before };
}

export const MAX_BOOKING_QUANTITY = 1000;

export interface ScrapBooking {
  id: string;
  machineId: string;
  machineName: string | null;
  workOrderId: string | null;
  orderNumber: string | null;
  partName: string | null;
  reasonCode: string;
  reasonName: string;
  quantity: number;
  mode: ScrapMode;
  note: string | null;
  bookedByName: string | null;
  terminalName: string | null;
  bookedAt: string;
}

/**
 * Books scrap: one booking row and one production_count event per part, written together; the events then reach the
 * live state and the dashboards like the machine's own parts.
 */
export async function bookScrap(input: {
  machineId: string;
  workOrderId: string | null;
  reason: ScrapReason;
  quantity: number;
  note: string | null;
  mode: ScrapMode;
  user: { id: string; name: string };
  terminal: { id: string; name: string } | null;
}): Promise<{ id: string; events: MachineEvent[] }> {
  const id = randomUUID();
  const now = Date.now();
  await pool.query(
    `INSERT INTO scrap_bookings (id, machine_id, work_order_id, reason_id, reason_code, reason_name, quantity, mode, note, booked_by, booked_by_name, terminal_id, terminal_name, booked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      id,
      input.machineId,
      input.workOrderId,
      input.reason.id,
      input.reason.code,
      input.reason.name,
      input.quantity,
      input.mode,
      input.note,
      input.user.id,
      input.user.name,
      input.terminal?.id ?? null,
      input.terminal?.name ?? null,
      new Date(now).toISOString(),
    ],
  );
  const events: MachineEvent[] = [];
  for (let i = 0; i < input.quantity; i++) {
    const event = {
      machineId: input.machineId,
      // A millisecond apart: the events keep their order and none lands in the future.
      timestamp: new Date(now - (input.quantity - 1 - i)).toISOString(),
      sourceEventId: `scrap-booking:${id}:${i}`,
      type: "production_count" as const,
      result: "scrap" as const,
      scrapReasonCode: input.reason.code,
      scrapReasonName: input.reason.name,
      reclassified: input.mode === "reclassify",
      bookingId: id,
      workOrderId: input.workOrderId ?? undefined,
      source: "terminal",
    };
    await insertEvent(event as unknown as MachineEvent);
    stateStore.applyEvent(event as unknown as MachineEvent);
    publishToHub(event as unknown as MachineEvent);
    events.push(event as unknown as MachineEvent);
  }
  return { id, events };
}

export interface ScrapFilter {
  from: Date;
  to?: Date;
  machineIds?: string[];
  workOrderId?: string;
}

interface Window {
  machineId: string;
  from: Date;
  to: Date | null;
}

/** The order's machine and time window (from its start to its completion, or now). */
async function workOrderWindow(workOrderId: string): Promise<Window | undefined> {
  const result = await pool.query<{ machine_id: string | null; started: Date | null; ended: Date | null }>(
    `SELECT (SELECT machine_id FROM work_order_assignments WHERE work_order_id = $1 ORDER BY planned_start LIMIT 1) AS machine_id,
            (SELECT min(occurred_at) FROM audit_log WHERE action = 'work_order_updated' AND target = $1 AND details->>'status' = 'in_progress') AS started,
            (SELECT max(occurred_at) FROM audit_log WHERE action IN ('work_order_updated', 'work_order_auto_completed') AND target = $1
               AND (details->>'status' IN ('completed', 'cancelled') OR action = 'work_order_auto_completed')) AS ended`,
    [workOrderId],
  );
  const r = result.rows[0];
  if (!r?.machine_id || !r.started) return undefined;
  return { machineId: r.machine_id, from: r.started, to: r.ended };
}

/**
 * One order's scrap from its runs (053): a closed run with what was reported, the open one with the machine's
 * count. Undefined for an order without runs (closed before runs existed): then its time window is used.
 */
async function orderScrapFromRuns(workOrderId: string): Promise<ScrapAnalysis | undefined> {
  const runs = await listRuns(workOrderId);
  if (runs.length === 0) return undefined;
  const wo = await pool.query<{ quantity: number; count_overproduction: boolean }>(`SELECT quantity, count_overproduction FROM work_orders WHERE id = $1`, [workOrderId]);
  const machines = new Map<string, { machineId: string; machineName: string; good: number; scrap: number; reasons: Map<string, ScrapByReason> }>();
  const all = new Map<string, ScrapByReason>();
  for (const run of runs) {
    if (!run.machineId) continue;
    let good: number;
    let lines: ScrapLine[];
    if (run.endedAt) {
      good = run.reportedGood ?? 0;
      lines = run.scrapBreakdown;
    } else {
      const live = await liveCounts(run, runs, wo.rows[0]?.quantity ?? 0, wo.rows[0]?.count_overproduction ?? false);
      good = live.good;
      lines = live.byReason;
    }
    const m = machines.get(run.machineId) ?? { machineId: run.machineId, machineName: run.machineName ?? run.machineId, good: 0, scrap: 0, reasons: new Map() };
    machines.set(run.machineId, m);
    m.good += good;
    for (const line of lines) {
      if (line.quantity <= 0) continue;
      const key = line.code ?? "\u0000none";
      m.scrap += line.quantity;
      for (const map of [m.reasons, all]) {
        const agg = map.get(key) ?? { code: line.code, name: line.name, quantity: 0, booked: 0 };
        agg.quantity += line.quantity;
        map.set(key, agg);
      }
    }
  }
  const booked = await pool.query<{ code: string; n: string }>(`SELECT reason_code AS code, sum(quantity) AS n FROM scrap_bookings WHERE work_order_id = $1 GROUP BY reason_code`, [workOrderId]);
  for (const b of booked.rows) {
    const agg = all.get(b.code);
    if (agg) agg.booked = Math.min(agg.quantity, Number(b.n));
  }
  const byMachine = [...machines.values()].map((m) => ({
    machineId: m.machineId,
    machineName: m.machineName,
    good: m.good,
    scrap: m.scrap,
    byReason: [...m.reasons.values()].sort((a, b) => b.quantity - a.quantity),
  }));
  return {
    totalScrap: byMachine.reduce((a, m) => a + m.scrap, 0),
    totalGood: byMachine.reduce((a, m) => a + m.good, 0),
    byReason: [...all.values()].sort((a, b) => b.quantity - a.quantity),
    byMachine,
  };
}

export interface ScrapByReason {
  code: string | null;
  name: string;
  quantity: number;
  /** How many of them were booked at a terminal (the rest came from the machine's signal). */
  booked: number;
}

export interface ScrapAnalysis {
  totalScrap: number;
  totalGood: number;
  byReason: ScrapByReason[];
  byMachine: { machineId: string; machineName: string; good: number; scrap: number; byReason: ScrapByReason[] }[];
}

/**
 * Scrap by reason and by machine in a period (or for one work order: its machine, from its start to its end).
 * The machine's own scrap signals without a reason are grouped as "no reason".
 */
export async function scrapAnalysis(f: ScrapFilter): Promise<ScrapAnalysis> {
  let machineIds = f.machineIds;
  let from = f.from;
  let to = f.to ?? null;
  if (f.workOrderId) {
    const byRuns = await orderScrapFromRuns(f.workOrderId);
    if (byRuns) return byRuns;
    const w = await workOrderWindow(f.workOrderId);
    if (!w) return { totalScrap: 0, totalGood: 0, byReason: [], byMachine: [] };
    machineIds = [w.machineId];
    from = w.from;
    to = w.to;
  }
  const result = await pool.query<{ machine_id: string; machine_name: string; code: string | null; name: string | null; scrap: string; booked: string; good: string }>(
    `WITH ev AS (
       SELECT e.machine_id, e.payload FROM events e
       WHERE e.type = 'production_count' AND e."timestamp" >= $1 AND ($2::timestamptz IS NULL OR e."timestamp" < $2)
         AND ($3::text[] IS NULL OR e.machine_id = ANY($3))
     ),
     goods AS (SELECT machine_id, ${goodCountSql()} AS good FROM ev GROUP BY machine_id),
     scraps AS (
       SELECT machine_id, payload->>'scrapReasonCode' AS code, max(payload->>'scrapReasonName') AS name,
              count(*) AS scrap, count(*) FILTER (WHERE payload->>'source' = 'terminal') AS booked
       FROM ev WHERE payload->>'result' = 'scrap' GROUP BY machine_id, payload->>'scrapReasonCode'
     )
     SELECT g.machine_id, m.name AS machine_name, s.code,
            COALESCE(s.name,
              (SELECT r.name FROM scrap_reasons r WHERE r.code = s.code AND (r.machine_id = g.machine_id OR r.machine_id IS NULL) ORDER BY r.machine_id NULLS LAST LIMIT 1)) AS name,
            COALESCE(s.scrap, 0) AS scrap, COALESCE(s.booked, 0) AS booked, g.good
     FROM goods g JOIN machines m ON m.id = g.machine_id
     LEFT JOIN scraps s ON s.machine_id = g.machine_id
     ORDER BY m.name`,
    [from, to, machineIds ?? null],
  );
  const machines = new Map<string, ScrapAnalysis["byMachine"][number]>();
  const reasons = new Map<string, ScrapByReason>();
  for (const r of result.rows) {
    const m = machines.get(r.machine_id) ?? { machineId: r.machine_id, machineName: r.machine_name, good: Number(r.good), scrap: 0, byReason: [] };
    machines.set(r.machine_id, m);
    const qty = Number(r.scrap);
    if (qty === 0) continue;
    const item = { code: r.code, name: r.name ?? (r.code ? r.code : "Ok nélkül"), quantity: qty, booked: Number(r.booked) };
    m.scrap += qty;
    m.byReason.push(item);
    const key = r.code ?? "\u0000none";
    const agg = reasons.get(key) ?? { code: r.code, name: item.name, quantity: 0, booked: 0 };
    agg.quantity += qty;
    agg.booked += item.booked;
    reasons.set(key, agg);
  }
  const byMachine = [...machines.values()].map((m) => ({ ...m, byReason: m.byReason.sort((a, b) => b.quantity - a.quantity) }));
  return {
    totalScrap: byMachine.reduce((a, m) => a + m.scrap, 0),
    totalGood: byMachine.reduce((a, m) => a + m.good, 0),
    byReason: [...reasons.values()].sort((a, b) => b.quantity - a.quantity),
    byMachine,
  };
}

type BookingRow = {
  id: string;
  machine_id: string;
  machine_name: string | null;
  work_order_id: string | null;
  order_number: string | null;
  part_name: string | null;
  reason_code: string;
  reason_name: string;
  quantity: number;
  mode: ScrapMode;
  note: string | null;
  booked_by_name: string | null;
  terminal_name: string | null;
  booked_at: Date;
};

export async function listBookingsPage(f: ScrapFilter & { q?: string; limit: number; offset: number }): Promise<{ rows: ScrapBooking[]; total: number }> {
  const where: string[] = [];
  const args: unknown[] = [];
  const arg = (v: unknown) => {
    args.push(v);
    return `$${args.length}`;
  };
  if (f.workOrderId) {
    // One order: all of its reports, whenever they were made.
    where.push(`b.work_order_id = ${arg(f.workOrderId)}`);
  } else {
    where.push(`b.booked_at >= ${arg(f.from)}`);
    if (f.to) where.push(`b.booked_at < ${arg(f.to)}`);
    if (f.machineIds) where.push(`b.machine_id = ANY(${arg(f.machineIds)})`);
  }
  if (f.q) where.push(`(wo.order_number ILIKE ${arg(`%${f.q}%`)} OR wo.part_name ILIKE $${args.length} OR b.reason_name ILIKE $${args.length} OR b.reason_code ILIKE $${args.length} OR m.name ILIKE $${args.length})`);
  const from = `FROM scrap_bookings b LEFT JOIN work_orders wo ON wo.id = b.work_order_id LEFT JOIN machines m ON m.id = b.machine_id WHERE ${where.join(" AND ")}`;
  const total = await pool.query<{ n: string }>(`SELECT count(*) AS n ${from}`, args);
  const rows = await pool.query<BookingRow>(
    `SELECT b.*, m.name AS machine_name, wo.order_number, wo.part_name ${from} ORDER BY b.booked_at DESC LIMIT ${arg(f.limit)} OFFSET ${arg(f.offset)}`,
    args,
  );
  return {
    total: Number(total.rows[0]?.n ?? 0),
    rows: rows.rows.map((r) => ({
      id: r.id,
      machineId: r.machine_id,
      machineName: r.machine_name,
      workOrderId: r.work_order_id,
      orderNumber: r.order_number,
      partName: r.part_name,
      reasonCode: r.reason_code,
      reasonName: r.reason_name,
      quantity: r.quantity,
      mode: r.mode,
      note: r.note,
      bookedByName: r.booked_by_name,
      terminalName: r.terminal_name,
      bookedAt: new Date(r.booked_at).toISOString(),
    })),
  };
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23503";
}
