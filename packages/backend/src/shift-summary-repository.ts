import { pool } from "./db.js";

export interface ShiftSummary {
  shiftDate: string;
  shiftName: string;
  machineId: string;
  goodCount: number;
  scrapCount: number;
  statusSeconds: Record<string, number>;
  runningSeconds: number;
  totalSeconds: number;
  productionRatio: number;
  availability: number;
  performance: number | null;
  quality: number | null;
  oee: number | null;
}

type CountsRow = {
  shift_date: string;
  shift_name: string;
  machine_id: string;
  good_count: number;
  scrap_count: number;
};

type DurationsRow = {
  shift_date: string;
  shift_name: string;
  machine_id: string;
  running_seconds: number;
  down_seconds: number;
  excluded_seconds: number;
  status_breakdown: Record<string, number> | null;
};

/**
 * Egy adott [from, to) időszakra visszaadja a jó/rossz darabszámot, az
 * állapot-időtartamokat (tetszőleges, egyedi állapotnevekkel is), és a
 * klasszikus OEE három komponensét.
 *
 * Az egyedi állapotok OEE-besorolását a machine_status_definitions tábla
 * adja (gép-specifikus bejegyzés felülírja az azonos kódú globálist);
 * a 'running' és 'down' mindig beépített. Az 'excluded' besorolású idő
 * (pl. tervezett átállás) kimarad a totalSeconds-ból — se nem ront, se
 * nem javít az elérhetőségen.
 */
export async function getShiftSummary(from: Date, to: Date): Promise<ShiftSummary[]> {
  const countsResult = await pool.query<CountsRow>(
    `SELECT
       r.shift_date::text AS shift_date,
       r.shift_name,
       e.machine_id,
       COUNT(*) FILTER (WHERE e.payload->>'result' = 'good')::int AS good_count,
       COUNT(*) FILTER (WHERE e.payload->>'result' = 'scrap')::int AS scrap_count
     FROM events e,
          LATERAL resolve_shift(e."timestamp") r
     WHERE e.type = 'production_count'
       AND e."timestamp" BETWEEN $1 AND $2
     GROUP BY r.shift_date, r.shift_name, e.machine_id`,
    [from, to],
  );

  const durationsResult = await pool.query<DurationsRow>(
    `WITH raw_status AS (
       SELECT
         machine_id,
         payload->>'status' AS status,
         "timestamp" AS started_at,
         LEAD("timestamp") OVER (PARTITION BY machine_id ORDER BY "timestamp") AS ended_at
       FROM events
       WHERE type = 'machine_status'
         AND "timestamp" BETWEEN $1::timestamptz - INTERVAL '1 day' AND $2::timestamptz + INTERVAL '1 day'
     ),
     clipped AS (
       SELECT
         rs.machine_id,
         rs.status,
         r.shift_date,
         r.shift_name,
         GREATEST(rs.started_at, sw.start_ts) AS clip_start,
         LEAST(COALESCE(rs.ended_at, now()), sw.end_ts) AS clip_end
       FROM raw_status rs
       JOIN LATERAL resolve_shift(rs.started_at) r ON true
       JOIN LATERAL (
         SELECT
           (r.shift_date + sd.start_time)::timestamptz AS start_ts,
           CASE WHEN sd.start_time <= sd.end_time
             THEN (r.shift_date + sd.end_time)::timestamptz
             ELSE (r.shift_date + INTERVAL '1 day' + sd.end_time)::timestamptz
           END AS end_ts
         FROM shift_definitions sd WHERE sd.name = r.shift_name
       ) sw ON true
     ),
     categorized AS (
       SELECT
         c.*,
         CASE
           WHEN c.status = 'running' THEN 'running'
           WHEN c.status = 'down' THEN 'counts_as_down'
           ELSE COALESCE(msd_machine.oee_category, msd_global.oee_category, 'counts_as_down')
         END AS oee_bucket
       FROM clipped c
       LEFT JOIN machine_status_definitions msd_machine
         ON msd_machine.machine_id = c.machine_id AND msd_machine.code = c.status
       LEFT JOIN machine_status_definitions msd_global
         ON msd_global.machine_id IS NULL AND msd_global.code = c.status
       WHERE c.clip_end > c.clip_start
     ),
     per_status AS (
       SELECT
         shift_date, shift_name, machine_id, status, oee_bucket,
         SUM(EXTRACT(EPOCH FROM (clip_end - clip_start)))::float AS seconds
       FROM categorized
       GROUP BY shift_date, shift_name, machine_id, status, oee_bucket
     )
     SELECT
       shift_date::text AS shift_date,
       shift_name,
       machine_id,
       COALESCE(SUM(seconds) FILTER (WHERE oee_bucket = 'running'), 0)::float AS running_seconds,
       COALESCE(SUM(seconds) FILTER (WHERE oee_bucket = 'counts_as_down'), 0)::float AS down_seconds,
       COALESCE(SUM(seconds) FILTER (WHERE oee_bucket = 'excluded'), 0)::float AS excluded_seconds,
       jsonb_object_agg(status, seconds) AS status_breakdown
     FROM per_status
     GROUP BY shift_date, shift_name, machine_id`,
    [from, to],
  );

  const merged = new Map<string, ShiftSummary>();

  for (const row of countsResult.rows) {
    const key = `${row.shift_date}|${row.shift_name}|${row.machine_id}`;
    merged.set(key, {
      shiftDate: row.shift_date,
      shiftName: row.shift_name,
      machineId: row.machine_id,
      goodCount: row.good_count,
      scrapCount: row.scrap_count,
      statusSeconds: {},
      runningSeconds: 0,
      totalSeconds: 0,
      productionRatio: 0,
      availability: 0,
      performance: null,
      quality: null,
      oee: null,
    });
  }

  for (const row of durationsResult.rows) {
    const key = `${row.shift_date}|${row.shift_name}|${row.machine_id}`;
    const existing = merged.get(key) ?? {
      shiftDate: row.shift_date,
      shiftName: row.shift_name,
      machineId: row.machine_id,
      goodCount: 0,
      scrapCount: 0,
      statusSeconds: {},
      runningSeconds: 0,
      totalSeconds: 0,
      productionRatio: 0,
      availability: 0,
      performance: null,
      quality: null,
      oee: null,
    };
    existing.runningSeconds = row.running_seconds;
    existing.statusSeconds = row.status_breakdown ?? {};
    // A totalSeconds a running + "counts_as_down" időket tartalmazza —
    // az "excluded" (tervezett) idő szándékosan kimarad, se nem ront, se
    // nem javít az elérhetőségen.
    existing.totalSeconds = row.running_seconds + row.down_seconds;
    merged.set(key, existing);
  }

  const machinesResult = await pool.query<{ id: string; ideal_cycle_time_seconds: string | null }>(
    `SELECT id, ideal_cycle_time_seconds FROM machines`,
  );
  const idealCycleTimeByMachine = new Map<string, number | null>(
    machinesResult.rows.map((r) => [r.id, r.ideal_cycle_time_seconds ? Number(r.ideal_cycle_time_seconds) : null]),
  );

  for (const summary of merged.values()) {
    summary.productionRatio = summary.totalSeconds > 0 ? summary.runningSeconds / summary.totalSeconds : 0;
    summary.availability = summary.productionRatio;

    const totalParts = summary.goodCount + summary.scrapCount;
    summary.quality = totalParts > 0 ? summary.goodCount / totalParts : null;

    const idealCycleTime = idealCycleTimeByMachine.get(summary.machineId) ?? null;
    summary.performance =
      idealCycleTime && summary.runningSeconds > 0
        ? Math.min(1, (idealCycleTime * totalParts) / summary.runningSeconds)
        : null;

    summary.oee =
      summary.performance !== null && summary.quality !== null
        ? summary.availability * summary.performance * summary.quality
        : null;
  }

  return [...merged.values()].sort(
    (a, b) => a.shiftDate.localeCompare(b.shiftDate) || a.shiftName.localeCompare(b.shiftName),
  );
}