import { pool } from "./db.js";
import { loadShiftWindows, localDateString, type ShiftWindow } from "./shift-windows.js";

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

const HOUR_MS = 3600_000;

type OeeBucket = "running" | "counts_as_down" | "excluded";

async function loadOeeCategories(): Promise<(machineId: string, status: string) => OeeBucket> {
  const defs = await pool.query<{ machine_id: string | null; code: string; oee_category: string }>(
    `SELECT machine_id, code, oee_category FROM machine_status_definitions`,
  );
  const perMachine = new Map<string, string>();
  const global = new Map<string, string>();
  for (const d of defs.rows) {
    if (d.machine_id) perMachine.set(`${d.machine_id}|${d.code}`, d.oee_category);
    else global.set(d.code, d.oee_category);
  }
  return (machineId, status) => {
    if (status === "running") return "running";
    if (status === "down") return "counts_as_down";
    const cat = perMachine.get(`${machineId}|${status}`) ?? global.get(status) ?? "counts_as_down";
    return cat === "excluded" ? "excluded" : "counts_as_down";
  };
}

async function loadIdealCycleTimes(): Promise<Map<string, number | null>> {
  const machinesResult = await pool.query<{ id: string; ideal_cycle_time_seconds: string | null }>(
    `SELECT id, ideal_cycle_time_seconds FROM machines`,
  );
  return new Map(machinesResult.rows.map((r) => [r.id, r.ideal_cycle_time_seconds ? Number(r.ideal_cycle_time_seconds) : null]));
}

function finalize(summary: ShiftSummary, idealCycleTime: number | null): ShiftSummary {
  summary.productionRatio = summary.totalSeconds > 0 ? summary.runningSeconds / summary.totalSeconds : 0;
  summary.availability = summary.productionRatio;
  const totalParts = summary.goodCount + summary.scrapCount;
  summary.quality = totalParts > 0 ? summary.goodCount / totalParts : null;
  summary.performance =
    idealCycleTime && summary.runningSeconds > 0 ? Math.min(1, (idealCycleTime * totalParts) / summary.runningSeconds) : null;
  summary.oee =
    summary.performance !== null && summary.quality !== null ? summary.availability * summary.performance * summary.quality : null;
  return summary;
}

/**
 * Egy adott [from, to) időszak műszakonkénti összesítője: jó/selejt darab,
 * állapot-időtartamok és az OEE három komponense — minden gépre, vagy csak a
 * megadottra. A műszakon kívül eső idő és darab "off_shift" sorokba kerül
 * (dátum: az óra helyi napja).
 *
 * Forrás: a közös műszakablakok (shift-windows.ts, ugyanazok, mint a
 * resolve_shift()-é és a Gantté) és az ÓRÁNKÉNTI összesítők
 * (machine_status_hourly, production_counts_hourly). Egész órára eső
 * műszakhatároknál (pl. 06/14/22) pontos; ha egy határ óra közepére esik, a
 * határt tartalmazó órát arányosan osztja. Független a nyers események
 * megőrzési idejétől, és egy havi összesítő is gyors.
 *
 * Korábban a nyers eseményekből számolt, és egy állapotszakaszt csak ahhoz
 * a műszakhoz rendelt, AMELYIKBEN ELKEZDŐDÖTT (annak végéig levágva) — egy
 * műszakhatáron át megszakítás nélkül futó gép következő műszakja így nem
 * kapott futási időt, egy egész műszakon át futó gépé nullát.
 */
export async function getShiftSummary(from: Date, to: Date, machineId?: string): Promise<ShiftSummary[]> {
  const [windows, statusRows, countRows, categoryOf, idealCycleTimes] = await Promise.all([
    loadShiftWindows(from, to, machineId),
    pool.query<{ machine_id: string; bucket_start: Date; status: string; seconds: string }>(
      `SELECT machine_id, bucket_start, status, seconds FROM machine_status_hourly
       WHERE bucket_start >= date_trunc('hour', $1::timestamptz) AND bucket_start < $2::timestamptz
         AND ($3::text IS NULL OR machine_id = $3)`,
      [from, to, machineId ?? null],
    ),
    pool.query<{ machine_id: string; bucket_start: Date; good_count: number; scrap_count: number }>(
      `SELECT machine_id, bucket_start, good_count, scrap_count FROM production_counts_hourly
       WHERE bucket_start >= date_trunc('hour', $1::timestamptz) AND bucket_start < $2::timestamptz
         AND ($3::text IS NULL OR machine_id = $3)`,
      [from, to, machineId ?? null],
    ),
    loadOeeCategories(),
    loadIdealCycleTimes(),
  ]);

  const windowsByMachine = new Map<string, ShiftWindow[]>();
  for (const w of windows) {
    const list = windowsByMachine.get(w.machineId) ?? [];
    list.push(w);
    windowsByMachine.set(w.machineId, list);
  }

  const summaries = new Map<string, ShiftSummary & { downSeconds: number }>();
  const get = (shiftDate: string, shiftName: string, mid: string) => {
    const key = `${shiftDate}|${shiftName}|${mid}`;
    let s = summaries.get(key);
    if (!s) {
      s = {
        shiftDate, shiftName, machineId: mid, goodCount: 0, scrapCount: 0, statusSeconds: {}, runningSeconds: 0,
        totalSeconds: 0, productionRatio: 0, availability: 0, performance: null, quality: null, oee: null, downSeconds: 0,
      };
      summaries.set(key, s);
    }
    return s;
  };

  /** Egy óra [b, b+1h) ∩ [from, to) felosztása műszakokra: [shiftDate, shiftName, arány] (0–1, az órára vetítve). */
  const splitHour = (mid: string, b: Date): [string, string, number][] => {
    const hs = Math.max(b.getTime(), from.getTime());
    const he = Math.min(b.getTime() + HOUR_MS, to.getTime());
    if (he <= hs) return [];
    const parts: [string, string, number][] = [];
    let covered = 0;
    for (const w of windowsByMachine.get(mid) ?? []) {
      const ov = Math.min(he, w.end.getTime()) - Math.max(hs, w.start.getTime());
      if (ov > 0) {
        parts.push([w.shiftDate, w.shiftName, ov / HOUR_MS]);
        covered += ov;
      }
    }
    const rest = he - hs - covered;
    if (rest > 0) parts.push([localDateString(new Date(hs)), "off_shift", rest / HOUR_MS]);
    return parts;
  };

  for (const r of statusRows.rows) {
    const seconds = Number(r.seconds);
    const bucket = categoryOf(r.machine_id, r.status);
    for (const [date, name, frac] of splitHour(r.machine_id, new Date(r.bucket_start))) {
      const s = get(date, name, r.machine_id);
      const sec = seconds * frac;
      s.statusSeconds[r.status] = (s.statusSeconds[r.status] ?? 0) + sec;
      if (bucket === "running") s.runningSeconds += sec;
      else if (bucket === "counts_as_down") s.downSeconds += sec;
    }
  }
  for (const r of countRows.rows) {
    for (const [date, name, frac] of splitHour(r.machine_id, new Date(r.bucket_start))) {
      const s = get(date, name, r.machine_id);
      s.goodCount += r.good_count * frac;
      s.scrapCount += r.scrap_count * frac;
    }
  }

  return [...summaries.values()]
    .map(({ downSeconds, ...s }) => {
      s.goodCount = Math.round(s.goodCount);
      s.scrapCount = Math.round(s.scrapCount);
      s.totalSeconds = s.runningSeconds + downSeconds;
      return finalize(s, idealCycleTimes.get(s.machineId) ?? null);
    })
    .sort((a, b) => a.shiftDate.localeCompare(b.shiftDate) || a.shiftName.localeCompare(b.shiftName) || a.machineId.localeCompare(b.machineId));
}

/**
 * Egy gép jelenlegi műszakjának összesítője, percre pontosan a nyers
 * eseményekből — ugyanaz a (helyes) számítás, mint az Overview-é, egy gépre
 * szűrve. Korábban a getShiftSummary() régi, műszakhatárnál hibás
 * változatát használta (terminál).
 */
export async function getCurrentShiftSummaryForMachine(machineId: string): Promise<ShiftSummary | undefined> {
  const [summary] = await getCurrentShiftSummaryForAllMachines(machineId);
  return summary;
}

/**
 * Minden aktív gép (vagy egy gép) aktuális műszakának összesítője EGY
 * lekérdezésben, percre pontosan a nyers eseményekből — a resolve_shift()-et
 * gépenként csak EGYSZER hívja, és minden gépet kizárólag a SAJÁT, szűk
 * műszakablakára korlátozva kérdez le.
 */
export async function getCurrentShiftSummaryForAllMachines(machineId?: string): Promise<ShiftSummary[]> {
  const result = await pool.query<{
    machine_id: string;
    shift_date: string;
    shift_name: string;
    good_count: string;
    scrap_count: string;
    running_seconds: string;
    total_seconds: string;
  }>(
    `
    WITH machine_shifts AS (
      SELECT m.id AS machine_id, m.shift_pattern_id, m.calendar_id, r.shift_date, r.shift_name
      FROM machines m, LATERAL resolve_shift(m.id, now()) r
      WHERE m.is_active AND ($1::text IS NULL OR m.id = $1)
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
        COUNT(e.*) FILTER (WHERE e.payload->>'result' = 'good') AS good_count,
        COUNT(e.*) FILTER (WHERE e.payload->>'result' = 'scrap') AS scrap_count
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
    `,
    [machineId ?? null],
  );

  const idealCycleTimeByMachine = await loadIdealCycleTimes();

  return result.rows.map((row) =>
    finalize(
      {
        shiftDate: row.shift_date,
        shiftName: row.shift_name,
        machineId: row.machine_id,
        goodCount: Number(row.good_count),
        scrapCount: Number(row.scrap_count),
        statusSeconds: {},
        runningSeconds: Number(row.running_seconds),
        totalSeconds: Number(row.total_seconds),
        productionRatio: 0,
        availability: 0,
        performance: null,
        quality: null,
        oee: null,
      },
      idealCycleTimeByMachine.get(row.machine_id) ?? null,
    ),
  );
}
