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
 * állapot-időtartamokat, és az OEE három komponensét — minden regisztrált
 * gépre, vagy ha machineId meg van adva, KIZÁRÓLAG arra az egy gépre
 * (ez utóbbi kritikus a teljesítmény szempontjából: az egy-gépes hívók,
 * mint getCurrentShiftSummaryForMachine, enélkül feleslegesen az összes
 * többi gép eseményeit is feldolgoznák a resolve_shift() LATERAL join-on
 * keresztül, majd JS-ben dobnák el őket).
 */
export async function getShiftSummary(from: Date, to: Date, machineId?: string): Promise<ShiftSummary[]> {
  const machineFilterCounts = machineId ? `AND e.machine_id = $3` : "";
  const countsParams: unknown[] = machineId ? [from, to, machineId] : [from, to];

  const countsResult = await pool.query<CountsRow>(
    `SELECT
       r.shift_date::text AS shift_date,
       r.shift_name,
       e.machine_id,
       COUNT(*) FILTER (WHERE e.payload->>'result' = 'good')::int AS good_count,
       COUNT(*) FILTER (WHERE e.payload->>'result' = 'scrap')::int AS scrap_count
     FROM events e,
          LATERAL resolve_shift(e.machine_id, e."timestamp") r
     WHERE e.type = 'production_count'
       AND e."timestamp" BETWEEN $1 AND $2
       ${machineFilterCounts}
     GROUP BY r.shift_date, r.shift_name, e.machine_id`,
    countsParams,
  );

  const machineFilterDurations = machineId ? `AND machine_id = $3` : "";
  const durationsParams: unknown[] = machineId ? [from, to, machineId] : [from, to];

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
         ${machineFilterDurations}
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
       JOIN LATERAL resolve_shift(rs.machine_id, rs.started_at) r ON true
              JOIN LATERAL (
         SELECT
           COALESCE(
             (r.shift_date + sps.start_time)::timestamptz,
             r.shift_date::timestamptz
           ) AS start_ts,
           COALESCE(
             CASE WHEN sps.start_time <= sps.end_time
               THEN (r.shift_date + sps.end_time)::timestamptz
               ELSE (r.shift_date + INTERVAL '1 day' + sps.end_time)::timestamptz
             END,
             (r.shift_date + INTERVAL '1 day')::timestamptz
           ) AS end_ts
         FROM (SELECT 1) dummy
         LEFT JOIN machines m ON m.id = rs.machine_id
         LEFT JOIN shift_pattern_shifts sps ON sps.shift_pattern_id = m.shift_pattern_id AND sps.name = r.shift_name
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
    durationsParams,
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

/**
 * A getShiftSummary(from, to, machineId) segítségével KIZÁRÓLAG erre az
 * egy gépre kérdez le, majd resolve_shift(machineId, now())-vel eldönti,
 * melyik a jelenlegi műszak.
 */
export async function getCurrentShiftSummaryForMachine(machineId: string): Promise<ShiftSummary | undefined> {
  const now = new Date();
  const currentShiftResult = await pool.query<{ shift_date: string; shift_name: string }>(
    `SELECT shift_date::text, shift_name FROM resolve_shift($1, $2)`,
    [machineId, now],
  );
  const current = currentShiftResult.rows[0];
  if (!current) return undefined;

  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const summaries = await getShiftSummary(from, now, machineId);
  return summaries.find((s) => s.shiftDate === current.shift_date && s.shiftName === current.shift_name);
}

/**
 * Minden aktív gép aktuális műszakának összesítőjét EGY lekérdezésben
 * adja vissza — a resolve_shift()-et gépenként csak EGYSZER hívja (nem
 * eseményenként), és minden gépet kizárólag a SAJÁT, szűk műszak-
 * ablakára korlátozva kérdez le. Ez teszi lehetővé, hogy az Overview
 * O(1) HTTP-kérésben frissüljön, függetlenül a gépek számától.
 */
export async function getCurrentShiftSummaryForAllMachines(): Promise<ShiftSummary[]> {
  const result = await pool.query<{
    machine_id: string;
    shift_date: string;
    shift_name: string;
    good_count: string;
    scrap_count: string;
    running_seconds: string;
    total_seconds: string;
  }>(`
    WITH machine_shifts AS (
      SELECT m.id AS machine_id, m.shift_pattern_id, m.calendar_id, r.shift_date, r.shift_name
      FROM machines m, LATERAL resolve_shift(m.id, now()) r
      WHERE m.is_active
    ),
    shift_windows AS (
      SELECT ms.machine_id, ms.shift_date, ms.shift_name,
        COALESCE(
          (ms.shift_date + sps.start_time)::timestamptz,
          ms.shift_date::timestamptz
        ) AS start_ts,
        LEAST(
          COALESCE(
            CASE WHEN sps.start_time <= sps.end_time
              THEN (ms.shift_date + sps.end_time)::timestamptz
              ELSE (ms.shift_date + INTERVAL '1 day' + sps.end_time)::timestamptz
            END,
            (ms.shift_date + INTERVAL '1 day')::timestamptz
          ),
          now()
        ) AS end_ts
      FROM machine_shifts ms
      LEFT JOIN shift_pattern_shifts sps
        ON sps.shift_pattern_id = ms.shift_pattern_id AND sps.name = ms.shift_name
    ),
    counts AS (
      SELECT sw.machine_id,
        COUNT(*) FILTER (WHERE e.payload->>'result' = 'good') AS good_count,
        COUNT(*) FILTER (WHERE e.payload->>'result' = 'scrap') AS scrap_count
      FROM shift_windows sw
      LEFT JOIN events e
        ON e.machine_id = sw.machine_id AND e.type = 'production_count'
        AND e."timestamp" >= sw.start_ts AND e."timestamp" < sw.end_ts
      GROUP BY sw.machine_id
    ),
    -- Csak a műszakablak eseményei + a műszak elején érvényes állapot (a
    -- műszak előtti utolsó esemény, gépenként indexelt LIMIT 1). Korábban az
    -- összes aktív gép TELJES státusztörténetét végigolvasta, minden Overview-
    -- frissítésnél.
    raw_status AS (
      SELECT sw.machine_id, x.status, x.started_at,
             LEAD(x.started_at) OVER (PARTITION BY sw.machine_id ORDER BY x.started_at) AS ended_at
      FROM shift_windows sw
      CROSS JOIN LATERAL (
        SELECT e.payload->>'status' AS status, e."timestamp" AS started_at
        FROM events e
        WHERE e.machine_id = sw.machine_id AND e.type = 'machine_status'
          AND e."timestamp" >= sw.start_ts AND e."timestamp" < sw.end_ts
        UNION ALL
        SELECT * FROM (
          SELECT p.payload->>'status' AS status, sw.start_ts AS started_at
          FROM events p
          WHERE p.machine_id = sw.machine_id AND p.type = 'machine_status' AND p."timestamp" < sw.start_ts
          ORDER BY p."timestamp" DESC LIMIT 1
        ) prev
      ) x
    ),
    status_overlap AS (
      SELECT sw.machine_id, rs.status,
        GREATEST(rs.started_at, sw.start_ts) AS clip_start,
        LEAST(COALESCE(rs.ended_at, now()), sw.end_ts) AS clip_end
      FROM shift_windows sw
      JOIN raw_status rs ON rs.machine_id = sw.machine_id
        AND rs.started_at < sw.end_ts AND COALESCE(rs.ended_at, now()) > sw.start_ts
    ),
    categorized AS (
      SELECT so.*,
        CASE
          WHEN so.status = 'running' THEN 'running'
          WHEN so.status = 'down' THEN 'counts_as_down'
          ELSE COALESCE(msd_m.oee_category, msd_g.oee_category, 'counts_as_down')
        END AS oee_bucket
      FROM status_overlap so
      LEFT JOIN machine_status_definitions msd_m ON msd_m.machine_id = so.machine_id AND msd_m.code = so.status
      LEFT JOIN machine_status_definitions msd_g ON msd_g.machine_id IS NULL AND msd_g.code = so.status
      WHERE so.clip_end > so.clip_start
    ),
    durations AS (
      SELECT machine_id,
        COALESCE(SUM(EXTRACT(EPOCH FROM (clip_end - clip_start))) FILTER (WHERE oee_bucket = 'running'), 0) AS running_seconds,
        COALESCE(SUM(EXTRACT(EPOCH FROM (clip_end - clip_start))) FILTER (WHERE oee_bucket IN ('running','counts_as_down')), 0) AS total_seconds
      FROM categorized
      GROUP BY machine_id
    )
    SELECT sw.machine_id, sw.shift_date::text, sw.shift_name,
      COALESCE(c.good_count, 0) AS good_count,
      COALESCE(c.scrap_count, 0) AS scrap_count,
      COALESCE(d.running_seconds, 0) AS running_seconds,
      COALESCE(d.total_seconds, 0) AS total_seconds
    FROM shift_windows sw
    LEFT JOIN counts c ON c.machine_id = sw.machine_id
    LEFT JOIN durations d ON d.machine_id = sw.machine_id
  `);

  const machinesResult = await pool.query<{ id: string; ideal_cycle_time_seconds: string | null }>(
    `SELECT id, ideal_cycle_time_seconds FROM machines`,
  );
  const idealCycleTimeByMachine = new Map<string, number | null>(
    machinesResult.rows.map((r) => [r.id, r.ideal_cycle_time_seconds ? Number(r.ideal_cycle_time_seconds) : null]),
  );

  return result.rows.map((row) => {
    const goodCount = Number(row.good_count);
    const scrapCount = Number(row.scrap_count);
    const runningSeconds = Number(row.running_seconds);
    const totalSeconds = Number(row.total_seconds);
    const totalParts = goodCount + scrapCount;
    const availability = totalSeconds > 0 ? runningSeconds / totalSeconds : 0;
    const quality = totalParts > 0 ? goodCount / totalParts : null;
    const idealCycleTime = idealCycleTimeByMachine.get(row.machine_id) ?? null;
    const performance =
      idealCycleTime && runningSeconds > 0 ? Math.min(1, (idealCycleTime * totalParts) / runningSeconds) : null;
    const oee = performance !== null && quality !== null ? availability * performance * quality : null;

    return {
      shiftDate: row.shift_date,
      shiftName: row.shift_name,
      machineId: row.machine_id,
      goodCount,
      scrapCount,
      statusSeconds: {},
      runningSeconds,
      totalSeconds,
      productionRatio: availability,
      availability,
      performance,
      quality,
      oee,
    };
  });
}