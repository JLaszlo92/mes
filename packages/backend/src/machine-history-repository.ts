import { pool } from "./db.js";

export type BucketUnit = "hour" | "day" | "week" | "month";

export interface MachineHistoryBucket {
  bucketStart: string;
  goodCount: number;
  scrapCount: number;
  statusSeconds: Record<string, number>;
  runningSeconds: number;
  totalSeconds: number;
  availability: number;
  performance: number | null;
  quality: number | null;
  oee: number | null;
  avgCycleTimeSeconds: number | null;
}

function truncateToBucket(date: Date, bucket: BucketUnit): Date {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  if (bucket === "hour") return d;
  d.setHours(0);
  if (bucket === "day") return d;
  if (bucket === "week") {
    const day = d.getDay();
    const diff = day === 0 ? 6 : day - 1;
    d.setDate(d.getDate() - diff);
    return d;
  }
  d.setDate(1);
  return d;
}

function advanceBucket(date: Date, bucket: BucketUnit): Date {
  const d = new Date(date);
  if (bucket === "hour") d.setHours(d.getHours() + 1);
  else if (bucket === "day") d.setDate(d.getDate() + 1);
  else if (bucket === "week") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

function generateBucketBoundaries(from: Date, to: Date, bucket: BucketUnit): Date[] {
  const boundaries: Date[] = [];
  let current = truncateToBucket(from, bucket);
  while (current < to) {
    boundaries.push(new Date(current));
    current = advanceBucket(current, bucket);
  }
  boundaries.push(new Date(current));
  return boundaries;
}

/**
 * Tetszőleges időszak-bontású (óra/nap/hét/hónap) történeti riport egy
 * gépre: jó/selejt darabszám, státusz-időtartamok, OEE, átlagos ciklusidő.
 * A bucket-határokat Node-ban generáljuk (nem tiszta SQL date_trunc-kal),
 * mert a "hét"/"hónap" bucket-ek változó hosszúságúak — így minden
 * státusz-szakaszt a tényleges bucket-határok mentén vágunk ketté, nem
 * csak a kezdő időbélyeg szerint soroljuk be (ami hosszú "running"
 * szakaszoknál torzítana).
 */
export async function getMachineHistory(
  machineId: string,
  from: Date,
  to: Date,
  bucket: BucketUnit,
): Promise<MachineHistoryBucket[]> {
  const boundaries = generateBucketBoundaries(from, to, bucket);

  const result = await pool.query<{
    bucket_start: string;
    good_count: string;
    scrap_count: string;
    status_breakdown: Record<string, number> | null;
    running_seconds: string;
  }>(
    `
    WITH buckets AS (
      SELECT idx, b AS bucket_start, LEAD(b) OVER (ORDER BY idx) AS bucket_end
      FROM unnest($2::timestamptz[]) WITH ORDINALITY AS t(b, idx)
    ),
    valid_buckets AS (
      SELECT * FROM buckets WHERE bucket_end IS NOT NULL
    ),
    counts AS (
      SELECT vb.bucket_start,
             COUNT(*) FILTER (WHERE e.payload->>'result' = 'good') AS good_count,
             COUNT(*) FILTER (WHERE e.payload->>'result' = 'scrap') AS scrap_count
      FROM valid_buckets vb
      LEFT JOIN events e ON e.type = 'production_count' AND e.machine_id = $1
        AND e."timestamp" >= vb.bucket_start AND e."timestamp" < vb.bucket_end
      GROUP BY vb.bucket_start
    ),
    raw_status AS (
      SELECT payload->>'status' AS status, "timestamp" AS started_at,
             LEAD("timestamp") OVER (ORDER BY "timestamp") AS ended_at
      FROM events
      WHERE type = 'machine_status' AND machine_id = $1
    ),
    status_overlap AS (
      SELECT vb.bucket_start, rs.status,
             GREATEST(rs.started_at, vb.bucket_start) AS clip_start,
             LEAST(COALESCE(rs.ended_at, now()), vb.bucket_end) AS clip_end
      FROM valid_buckets vb
      JOIN raw_status rs
        ON rs.started_at < vb.bucket_end AND COALESCE(rs.ended_at, now()) > vb.bucket_start
    ),
    status_seconds AS (
    SELECT bucket_start,
            COALESCE(SUM(seconds) FILTER (WHERE status = 'running'), 0) AS running_seconds,
            jsonb_object_agg(status, seconds) AS status_breakdown
    FROM (
        SELECT bucket_start, status, SUM(EXTRACT(EPOCH FROM (clip_end - clip_start))) AS seconds
        FROM status_overlap
        WHERE clip_end > clip_start
        GROUP BY bucket_start, status
      ) per_status
      GROUP BY bucket_start
    )
    SELECT
      vb.bucket_start::text,
      COALESCE(c.good_count, 0) AS good_count,
      COALESCE(c.scrap_count, 0) AS scrap_count,
      COALESCE(ss.status_breakdown, '{}'::jsonb) AS status_breakdown,
      COALESCE(ss.running_seconds, 0) AS running_seconds
    FROM valid_buckets vb
    LEFT JOIN counts c ON c.bucket_start = vb.bucket_start
    LEFT JOIN status_seconds ss ON ss.bucket_start = vb.bucket_start
    ORDER BY vb.bucket_start
    `,
    [machineId, boundaries],
  );

  const machineResult = await pool.query<{ ideal_cycle_time_seconds: string | null }>(
    `SELECT ideal_cycle_time_seconds FROM machines WHERE id = $1`,
    [machineId],
  );
  const idealCycleTime = machineResult.rows[0]?.ideal_cycle_time_seconds
    ? Number(machineResult.rows[0].ideal_cycle_time_seconds)
    : null;

  const statusDefsResult = await pool.query<{ code: string; oee_category: string }>(
    `SELECT code, oee_category FROM machine_status_definitions WHERE machine_id = $1 OR machine_id IS NULL`,
    [machineId],
  );
  const categoryByCode = new Map<string, string>();
  for (const row of statusDefsResult.rows) {
    if (!categoryByCode.has(row.code)) categoryByCode.set(row.code, row.oee_category);
  }

  return result.rows.map((row) => {
    const statusSeconds: Record<string, number> = row.status_breakdown ?? {};
    const runningSeconds = Number(row.running_seconds);
    let downLikeSeconds = 0;
    for (const [status, seconds] of Object.entries(statusSeconds)) {
      if (status === "running") continue;
      const category = status === "down" ? "counts_as_down" : categoryByCode.get(status) ?? "counts_as_down";
      if (category === "counts_as_down") downLikeSeconds += seconds;
    }
    const totalSeconds = runningSeconds + downLikeSeconds;
    const goodCount = Number(row.good_count);
    const scrapCount = Number(row.scrap_count);
    const totalParts = goodCount + scrapCount;
    const availability = totalSeconds > 0 ? runningSeconds / totalSeconds : 0;
    const quality = totalParts > 0 ? goodCount / totalParts : null;
    const performance =
      idealCycleTime && runningSeconds > 0 ? Math.min(1, (idealCycleTime * totalParts) / runningSeconds) : null;
    const oee = performance !== null && quality !== null ? availability * performance * quality : null;
    const avgCycleTimeSeconds = totalParts > 0 && runningSeconds > 0 ? runningSeconds / totalParts : null;

    return {
      bucketStart: row.bucket_start,
      goodCount,
      scrapCount,
      statusSeconds,
      runningSeconds,
      totalSeconds,
      availability,
      performance,
      quality,
      oee,
      avgCycleTimeSeconds,
    };
  });
}