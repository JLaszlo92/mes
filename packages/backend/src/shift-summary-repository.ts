import { pool } from "./db.js";

export interface ShiftSummary {
  shiftDate: string;
  shiftName: string;
  machineId: string;
  goodCount: number;
  scrapCount: number;
  runningSeconds: number;
  idleSeconds: number;
  downSeconds: number;
  changeoverSeconds: number;
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
  idle_seconds: number;
  down_seconds: number;
  changeover_seconds: number;
};

/**
 * Egy adott [from, to) időszakra visszaadja a jó/rossz darabszámot, a
 * gyártás/nem-gyártás állapot-időtartamokat, és a klasszikus OEE három
 * komponensét (Availability × Performance × Quality), műszak- és
 * gépenkénti bontásban.
 *
 * Performance és Quality (és így az OEE is) null marad, ha nincs elég
 * adat a számításhoz (nincs beállítva ideális ciklusidő a gépnél, vagy
 * nincs darabszám a műszakban) — nem hamisítunk be egy semleges 100%-ot,
 * mert az félrevezető lenne a dashboardon.
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
     )
     SELECT
       shift_date::text AS shift_date,
       shift_name,
       machine_id,
       COALESCE(SUM(EXTRACT(EPOCH FROM (clip_end - clip_start))) FILTER (WHERE status = 'running'), 0)::float AS running_seconds,
       COALESCE(SUM(EXTRACT(EPOCH FROM (clip_end - clip_start))) FILTER (WHERE status = 'idle'), 0)::float AS idle_seconds,
       COALESCE(SUM(EXTRACT(EPOCH FROM (clip_end - clip_start))) FILTER (WHERE status = 'down'), 0)::float AS down_seconds,
       COALESCE(SUM(EXTRACT(EPOCH FROM (clip_end - clip_start))) FILTER (WHERE status = 'changeover'), 0)::float AS changeover_seconds
     FROM clipped
     WHERE clip_end > clip_start
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
      runningSeconds: 0,
      idleSeconds: 0,
      downSeconds: 0,
      changeoverSeconds: 0,
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
      runningSeconds: 0,
      idleSeconds: 0,
      downSeconds: 0,
      changeoverSeconds: 0,
      totalSeconds: 0,
      productionRatio: 0,
      availability: 0,
      performance: null,
      quality: null,
      oee: null,
    };
    existing.runningSeconds = row.running_seconds;
    existing.idleSeconds = row.idle_seconds;
    existing.downSeconds = row.down_seconds;
    existing.changeoverSeconds = row.changeover_seconds;
    merged.set(key, existing);
  }

  // Az ideális ciklusidő géphez kötött, nem eseményhez — külön
  // lekérdezés, mert a shift-instanciák és a gép-törzsadat különböző
  // élettartamú dolgok.
  const machinesResult = await pool.query<{ id: string; ideal_cycle_time_seconds: string | null }>(
    `SELECT id, ideal_cycle_time_seconds FROM machines`,
  );
  const idealCycleTimeByMachine = new Map<string, number | null>(
    machinesResult.rows.map((r) => [r.id, r.ideal_cycle_time_seconds ? Number(r.ideal_cycle_time_seconds) : null]),
  );

  for (const summary of merged.values()) {
    summary.totalSeconds =
      summary.runningSeconds + summary.idleSeconds + summary.downSeconds + summary.changeoverSeconds;
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