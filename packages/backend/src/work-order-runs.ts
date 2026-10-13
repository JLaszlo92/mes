import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
import { goodCountSql, scrapCountSql } from "./count-sql.js";

/**
 * Egy megbízás futásai (053): a gépen töltött szakaszok az indítástól /
 * folytatástól a lejelentésig (szüneteltetés vagy lezárás).
 *
 * - A nyitott futás alatt a gép számol: a megbízás darabszáma a gép
 *   eseményeiből jön (a futás kezdetétől, a hátralévő mennyiségig).
 * - Lejelentéskor a futás lezárul: eltároljuk, mit számolt a gép (counted)
 *   és mit jelentett le a dolgozó (reported) — a megbízás innentől a
 *   lejelentett számokkal halad tovább.
 */

export interface ScrapLine {
  code: string | null;
  name: string;
  quantity: number;
}

export interface WorkOrderRun {
  id: string;
  workOrderId: string;
  machineId: string | null;
  machineName: string | null;
  startedAt: string;
  startedByName: string | null;
  endedAt: string | null;
  endReason: "paused" | "completed" | "cancelled" | null;
  countedGood: number | null;
  countedScrap: number | null;
  reportedGood: number | null;
  reportedScrap: number | null;
  scrapBreakdown: ScrapLine[];
  reportedManually: boolean;
  endedByName: string | null;
  terminalName: string | null;
}

type RunRow = {
  id: string;
  work_order_id: string;
  machine_id: string | null;
  machine_name: string | null;
  started_at: Date;
  started_by_name: string | null;
  ended_at: Date | null;
  end_reason: WorkOrderRun["endReason"];
  counted_good: number | null;
  counted_scrap: number | null;
  reported_good: number | null;
  reported_scrap: number | null;
  scrap_breakdown: ScrapLine[] | null;
  reported_manually: boolean;
  ended_by_name: string | null;
  terminal_name: string | null;
};

function toRun(r: RunRow): WorkOrderRun {
  return {
    id: r.id,
    workOrderId: r.work_order_id,
    machineId: r.machine_id,
    machineName: r.machine_name,
    startedAt: new Date(r.started_at).toISOString(),
    startedByName: r.started_by_name,
    endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
    endReason: r.end_reason,
    countedGood: r.counted_good,
    countedScrap: r.counted_scrap,
    reportedGood: r.reported_good,
    reportedScrap: r.reported_scrap,
    scrapBreakdown: r.scrap_breakdown ?? [],
    reportedManually: r.reported_manually,
    endedByName: r.ended_by_name,
    terminalName: r.terminal_name,
  };
}

const SELECT = `SELECT r.*, m.name AS machine_name FROM work_order_runs r LEFT JOIN machines m ON m.id = r.machine_id`;

export async function listRuns(workOrderId: string): Promise<WorkOrderRun[]> {
  const result = await pool.query<RunRow>(`${SELECT} WHERE r.work_order_id = $1 ORDER BY r.started_at, r.id`, [workOrderId]);
  return result.rows.map(toRun);
}

export async function getOpenRun(workOrderId: string): Promise<WorkOrderRun | undefined> {
  const result = await pool.query<RunRow>(`${SELECT} WHERE r.work_order_id = $1 AND r.ended_at IS NULL`, [workOrderId]);
  return result.rows[0] ? toRun(result.rows[0]) : undefined;
}

/** Opens a run (start or resume); if one is already open, that one is kept. */
export async function openRun(input: { workOrderId: string; machineId: string | null; user: { id: string | null; name: string | null } | null }): Promise<WorkOrderRun> {
  await pool.query(
    `INSERT INTO work_order_runs (id, work_order_id, machine_id, started_by, started_by_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (work_order_id) WHERE ended_at IS NULL DO NOTHING`,
    [randomUUID(), input.workOrderId, input.machineId, input.user?.id ?? null, input.user?.name ?? null],
  );
  return (await getOpenRun(input.workOrderId))!;
}

export interface WindowCounts {
  good: number;
  scrap: number;
  byReason: ScrapLine[];
}

/**
 * What the machine counted for an order from `from`: good and scrap parts (and scrap by reason). With a cap (the
 * quantity still to make), the count stops at the cap-th good part — later parts belong to the next order; scrap
 * booked for this order afterwards still counts. A reclassified booking moves the cap by one.
 */
export async function countWindow(machineId: string, from: Date | string, cap: number | null, workOrderId: string): Promise<WindowCounts> {
  let cappedAt: Date | string | null = null;
  if (cap !== null) {
    if (cap <= 0) {
      cappedAt = from;
    } else {
      const reclassified = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM events WHERE type = 'production_count' AND machine_id = $1 AND "timestamp" >= $2
         AND payload->>'result' = 'scrap' AND payload->>'reclassified' = 'true'`,
        [machineId, from],
      );
      const nth = await pool.query<{ timestamp: Date }>(
        `SELECT "timestamp" FROM events
         WHERE type = 'production_count' AND machine_id = $1 AND payload->>'result' = 'good' AND "timestamp" >= $2
         ORDER BY "timestamp" ASC OFFSET $3 LIMIT 1`,
        [machineId, from, cap - 1 + Number(reclassified.rows[0]?.n ?? 0)],
      );
      cappedAt = nth.rows[0]?.timestamp ?? null;
    }
  }
  const where = `type = 'production_count' AND machine_id = $1 AND "timestamp" >= $2
    AND ("timestamp" <= COALESCE($3::timestamptz, now()) OR payload->>'workOrderId' = $4)`;
  const args = [machineId, from, cappedAt, workOrderId];
  const [totals, reasons] = await Promise.all([
    pool.query<{ good: string; scrap: string }>(`SELECT ${goodCountSql()} AS good, ${scrapCountSql()} AS scrap FROM events WHERE ${where}`, args),
    pool.query<{ code: string | null; name: string | null; n: string }>(
      `SELECT e.code, COALESCE(e.name,
                (SELECT r.name FROM scrap_reasons r WHERE r.code = e.code AND (r.machine_id = $1 OR r.machine_id IS NULL) ORDER BY r.machine_id NULLS LAST LIMIT 1)) AS name,
              e.n
       FROM (SELECT payload->>'scrapReasonCode' AS code, max(payload->>'scrapReasonName') AS name, count(*) AS n
             FROM events WHERE ${where} AND payload->>'result' = 'scrap' GROUP BY 1) e
       ORDER BY e.n DESC`,
      args,
    ),
  ]);
  return {
    good: Math.max(0, Number(totals.rows[0]?.good ?? 0)),
    scrap: Number(totals.rows[0]?.scrap ?? 0),
    byReason: reasons.rows.map((r) => ({ code: r.code, name: r.name ?? r.code ?? "Ok nélkül", quantity: Number(r.n) })),
  };
}

/**
 * What a report does: with the good parts reached (earlier runs + this report) and no pause asked, the order
 * completes; otherwise it is paused. A report without a good count (an older screen) completes, as before.
 */
export function reportOutcome(input: { previousGood: number; good: number | undefined; quantity: number; pause: boolean }): "completed" | "paused" {
  if (input.pause) return "paused";
  if (input.good === undefined) return "completed";
  return input.previousGood + input.good >= input.quantity ? "completed" : "paused";
}

/** Totals of the closed runs (what was reported). */
export function closedTotals(runs: readonly WorkOrderRun[]): { good: number; scrap: number } {
  let good = 0;
  let scrap = 0;
  for (const r of runs) {
    if (r.endedAt === null) continue;
    good += r.reportedGood ?? 0;
    scrap += r.reportedScrap ?? 0;
  }
  return { good, scrap };
}

/** The open run's machine count (capped at what is still missing after the closed runs). */
export async function liveCounts(run: WorkOrderRun, runs: readonly WorkOrderRun[], quantity: number, countOverproduction: boolean): Promise<WindowCounts> {
  if (!run.machineId) return { good: 0, scrap: 0, byReason: [] };
  const cap = countOverproduction || quantity <= 0 ? null : quantity - closedTotals(runs).good;
  return countWindow(run.machineId, run.startedAt, cap, run.workOrderId);
}

/** Closes the open run with the numbers given. */
export async function closeRun(input: {
  runId: string;
  endReason: "paused" | "completed" | "cancelled";
  counted: { good: number; scrap: number };
  reported: { good: number; scrap: number };
  breakdown: ScrapLine[];
  manual: boolean;
  user: { id: string | null; name: string | null } | null;
  terminal: { id: string; name: string } | null;
}): Promise<WorkOrderRun | undefined> {
  const result = await pool.query<{ id: string }>(
    `UPDATE work_order_runs SET ended_at = now(), end_reason = $2, counted_good = $3, counted_scrap = $4,
            reported_good = $5, reported_scrap = $6, scrap_breakdown = $7::jsonb, reported_manually = $8,
            ended_by = $9, ended_by_name = $10, terminal_id = $11, terminal_name = $12
     WHERE id = $1 AND ended_at IS NULL RETURNING id`,
    [
      input.runId,
      input.endReason,
      input.counted.good,
      input.counted.scrap,
      input.reported.good,
      input.reported.scrap,
      JSON.stringify(input.breakdown),
      input.manual,
      input.user?.id ?? null,
      input.user?.name ?? null,
      input.terminal?.id ?? null,
      input.terminal?.name ?? null,
    ],
  );
  if (!result.rows[0]) return undefined;
  const runs = await pool.query<RunRow>(`${SELECT} WHERE r.id = $1`, [input.runId]);
  return runs.rows[0] ? toRun(runs.rows[0]) : undefined;
}

/**
 * Keeps the runs in step with a status change made without a report (dashboard, auto-complete, bulk cancel):
 * into in_progress opens a run; out of it closes the open run with the machine's count as the reported one.
 */
export async function syncRunsOnStatusChange(input: {
  workOrderId: string;
  to: string;
  machineId?: string | null;
  user: { id: string | null; name: string | null } | null;
}): Promise<void> {
  const open = await getOpenRun(input.workOrderId);
  if (input.to === "in_progress") {
    if (open) return;
    const machineId =
      input.machineId ??
      (await pool.query<{ machine_id: string }>(`SELECT machine_id FROM work_order_assignments WHERE work_order_id = $1 ORDER BY planned_start LIMIT 1`, [input.workOrderId])).rows[0]
        ?.machine_id ??
      null;
    await openRun({ workOrderId: input.workOrderId, machineId, user: input.user });
    return;
  }
  if (!open) return;
  const endReason = input.to === "completed" ? "completed" : input.to === "cancelled" ? "cancelled" : "paused";
  const wo = await pool.query<{ quantity: number; count_overproduction: boolean }>(`SELECT quantity, count_overproduction FROM work_orders WHERE id = $1`, [input.workOrderId]);
  const runs = await listRuns(input.workOrderId);
  const live = await liveCounts(open, runs, wo.rows[0]?.quantity ?? 0, wo.rows[0]?.count_overproduction ?? false);
  await closeRun({
    runId: open.id,
    endReason,
    counted: { good: live.good, scrap: live.scrap },
    reported: { good: live.good, scrap: live.scrap },
    breakdown: live.byReason,
    manual: false,
    user: input.user,
    terminal: null,
  });
}
