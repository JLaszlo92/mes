import type { FastifyBaseLogger } from "fastify";
import { pool } from "./db.js";
import { raiseOrUpdateSystemAlert, resolveSystemAlert } from "./alerts-repository.js";

/**
 * Raises ONE system alert while there are `data_gap` events in the last DATA_GAP_ALERT_HOURS (default 24): parts the
 * edge agent could not book (agent restart, lost PLC link, a catch-up that was too old). A data gap is a point in the
 * past, not a state, so the alert follows a window: it stays open while a gap is inside the window (its text lists
 * the machines and the lost parts) and resolves by itself when the window is clean. Acknowledge works as for any alert.
 *
 * Settings (environment of the backend service, optional):
 *   DATA_GAP_ALERT_HOURS   default 24
 */

export const DATA_GAP_ALERT_TYPE = "data_gap";
export const DEFAULT_DATA_GAP_WINDOW_HOURS = 24;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const MAX_LISTED = 5;

export interface DataGapSummary {
  machineId: string;
  machineName: string | null;
  gaps: number;
  lostGood: number;
  lostScrap: number;
  /** Time of the latest gap event. */
  lastAt: Date;
}

export type DataGapHealth = { healthy: true } | { healthy: false; message: string };

export function dataGapWindowHoursFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.DATA_GAP_ALERT_HOURS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_DATA_GAP_WINDOW_HOURS;
}

function formatUtc(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Pure: no gaps in the window is healthy; otherwise one stable message, most recent machine first. */
export function assessDataGaps(rows: readonly DataGapSummary[], windowHours: number): DataGapHealth {
  if (rows.length === 0) return { healthy: true };
  const sorted = [...rows].sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
  const listed = sorted
    .slice(0, MAX_LISTED)
    .map(
      (r) =>
        `${r.machineName ?? r.machineId} — ${r.gaps} ${r.gaps === 1 ? "gap" : "gaps"}, ${r.lostGood} good + ${r.lostScrap} scrap parts not booked (latest ${formatUtc(r.lastAt)})`,
    )
    .join("; ");
  const more = sorted.length > MAX_LISTED ? ` and ${sorted.length - MAX_LISTED} more` : "";
  const machines = sorted.length === 1 ? "1 machine" : `${sorted.length} machines`;
  return {
    healthy: false,
    message:
      `Parts were not booked on ${machines} in the last ${windowHours} h: ${listed}${more}. ` +
      "The edge agent could not place a counter change in time (agent restart or lost PLC link) — check the machine's connection; the counts for that period are too low.",
  };
}

interface Row {
  machine_id: string;
  name: string | null;
  gaps: string | number;
  lost_good: string | number;
  lost_scrap: string | number;
  last_at: Date | string;
}

export async function readDataGaps(windowHours: number): Promise<DataGapSummary[]> {
  const result = await pool.query<Row>(
    `SELECT e.machine_id, m.name,
            count(*)::int AS gaps,
            COALESCE(sum((e.payload->>'lostGood')::int), 0)::int AS lost_good,
            COALESCE(sum((e.payload->>'lostScrap')::int), 0)::int AS lost_scrap,
            max(e."timestamp") AS last_at
       FROM events e
       LEFT JOIN machines m ON m.id = e.machine_id
      WHERE e.type = 'data_gap'
        AND e."timestamp" > now() - make_interval(secs => $1::double precision)
      GROUP BY e.machine_id, m.name`,
    [windowHours * 3600],
  );
  return result.rows.map((r) => ({
    machineId: r.machine_id,
    machineName: r.name,
    gaps: Number(r.gaps),
    lostGood: Number(r.lost_good),
    lostScrap: Number(r.lost_scrap),
    lastAt: new Date(r.last_at),
  }));
}

export function createDataGapCheck(log: FastifyBaseLogger, windowHours: number): () => Promise<void> {
  return async () => {
    const health = assessDataGaps(await readDataGaps(windowHours), windowHours);
    if (health.healthy) {
      if (await resolveSystemAlert(DATA_GAP_ALERT_TYPE)) log.info("no data gap in the window any more — alert resolved");
      return;
    }
    if (await raiseOrUpdateSystemAlert(DATA_GAP_ALERT_TYPE, health.message)) {
      log.warn({ reason: health.message }, "data gap alert raised");
    }
  };
}

export function startDataGapEvaluator(log: FastifyBaseLogger): void {
  const check = createDataGapCheck(log, dataGapWindowHoursFromEnv());
  const run = () => {
    check().catch((err) => log.error({ err }, "data gap check failed"));
  };
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}
