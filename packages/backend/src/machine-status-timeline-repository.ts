import { pool } from "./db.js";

export interface StatusSegment {
  status: string;
  startedAt: string;
  endedAt: string;
}

const MAX_SEGMENTS = 300;

/**
 * Egy adott gép állapot-szakaszait adja vissza [from, to) tartományra.
 *
 * Forrás:
 *  - ameddig nyers státuszesemények vannak (a megőrzési időn belül): a nyers
 *    események, percre pontosan. Csak a [from, to) tartomány eseményeit
 *    olvassa, plusz a from előtti utolsót (a from-kor érvényes állapot) —
 *    korábban minden hívás a gép TELJES státusztörténetét végigolvasta;
 *  - a legrégebbi megmaradt nyers esemény ELŐTTI részre: az óránkénti
 *    összesítő (machine_status_hourly), óránként a domináns állapottal.
 *
 * Ha egy nagyon "flappelő" gép miatt túl sok szakasz jönne össze, fix számú,
 * egyenlő szélességű időrésre egyszerűsítjük, mindegyikhez a domináns
 * (leghosszabb ideig tartó) státuszt választva.
 */
export async function getStatusTimeline(machineId: string, from: Date, to: Date): Promise<StatusSegment[]> {
  const floorResult = await pool.query<{ oldest: Date | null }>(
    `SELECT "timestamp" AS oldest FROM events
     WHERE machine_id = $1 AND type = 'machine_status'
     ORDER BY "timestamp" ASC LIMIT 1`,
    [machineId],
  );
  const oldestRaw = floorResult.rows[0]?.oldest ?? null;
  const rawFrom = oldestRaw && oldestRaw > from ? oldestRaw : from;

  const segments: StatusSegment[] = [];

  // 1) A nyers adat előtti rész: óránként domináns állapot az összesítőből.
  const rollupTo = oldestRaw ? (oldestRaw < to ? oldestRaw : to) : to;
  if (rollupTo > from) {
    const hourly = await pool.query<{ status: string; started_at: Date; ended_at: Date }>(
      `SELECT DISTINCT ON (bucket_start) status,
              GREATEST(bucket_start, $2::timestamptz) AS started_at,
              LEAST(bucket_start + interval '1 hour', $3::timestamptz) AS ended_at
       FROM machine_status_hourly
       WHERE machine_id = $1 AND bucket_start < $3::timestamptz AND bucket_start + interval '1 hour' > $2::timestamptz
       ORDER BY bucket_start, seconds DESC, status`,
      [machineId, from, rollupTo],
    );
    for (const r of hourly.rows) {
      segments.push({ status: r.status, startedAt: r.started_at.toISOString(), endedAt: r.ended_at.toISOString() });
    }
  }

  // 2) A nyers rész: a tartomány eseményei + a kezdetkor érvényes állapot.
  if (oldestRaw && rawFrom < to) {
    const raw = await pool.query<{ status: string; started_at: Date; ended_at: Date }>(
      `
      WITH ev AS (
        SELECT payload->>'status' AS status, "timestamp" AS ts
        FROM events
        WHERE machine_id = $1 AND type = 'machine_status' AND "timestamp" >= $2::timestamptz AND "timestamp" < $3::timestamptz
        UNION ALL
        SELECT * FROM (
          SELECT payload->>'status' AS status, $2::timestamptz AS ts
          FROM events
          WHERE machine_id = $1 AND type = 'machine_status' AND "timestamp" < $2::timestamptz
          ORDER BY "timestamp" DESC LIMIT 1
        ) prev
      ),
      seg AS (
        SELECT status, ts AS started_at,
               COALESCE(LEAD(ts) OVER (ORDER BY ts), LEAST(now(), $3::timestamptz)) AS ended_at
        FROM ev
      )
      SELECT status, started_at, ended_at FROM seg WHERE ended_at > started_at ORDER BY started_at
      `,
      [machineId, rawFrom, to],
    );
    for (const r of raw.rows) {
      segments.push({ status: r.status, startedAt: r.started_at.toISOString(), endedAt: r.ended_at.toISOString() });
    }
  }

  if (segments.length <= MAX_SEGMENTS) return mergeAdjacent(segments);

  const totalMs = to.getTime() - from.getTime();
  const bucketMs = totalMs / MAX_SEGMENTS;
  const buckets: Map<string, number>[] = Array.from({ length: MAX_SEGMENTS }, () => new Map());

  for (const seg of segments) {
    const segStart = new Date(seg.startedAt).getTime();
    const segEnd = new Date(seg.endedAt).getTime();
    const firstBucket = Math.max(0, Math.floor((segStart - from.getTime()) / bucketMs));
    const lastBucket = Math.min(MAX_SEGMENTS - 1, Math.floor((segEnd - from.getTime() - 1) / bucketMs));

    for (let i = firstBucket; i <= lastBucket; i++) {
      const bucketStart = from.getTime() + i * bucketMs;
      const bucketEnd = bucketStart + bucketMs;
      const overlapMs = Math.max(0, Math.min(segEnd, bucketEnd) - Math.max(segStart, bucketStart));
      const bucket = buckets[i]!;
      if (overlapMs > 0) bucket.set(seg.status, (bucket.get(seg.status) ?? 0) + overlapMs);
    }
  }

  const simplified: StatusSegment[] = [];
  for (let i = 0; i < MAX_SEGMENTS; i++) {
    const bucket = buckets[i]!;
    if (bucket.size === 0) continue;
    let dominantStatus = "";
    let maxDuration = -1;
    for (const [status, duration] of bucket) {
      if (duration > maxDuration) {
        dominantStatus = status;
        maxDuration = duration;
      }
    }
    simplified.push({
      status: dominantStatus,
      startedAt: new Date(from.getTime() + i * bucketMs).toISOString(),
      endedAt: new Date(from.getTime() + (i + 1) * bucketMs).toISOString(),
    });
  }

  return mergeAdjacent(simplified);
}

function mergeAdjacent(segments: StatusSegment[]): StatusSegment[] {
  const merged: StatusSegment[] = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (last && last.status === seg.status && last.endedAt === seg.startedAt) {
      last.endedAt = seg.endedAt;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}
