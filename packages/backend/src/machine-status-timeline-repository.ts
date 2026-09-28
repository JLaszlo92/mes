import { pool } from "./db.js";

export interface StatusSegment {
  status: string;
  startedAt: string;
  endedAt: string;
}

const MAX_SEGMENTS = 300;

/**
 * Egy adott gép állapot-szakaszait adja vissza [from, to) tartományra.
 * Ha egy nagyon "flappelő" gép miatt túl sok nyers szakasz jönne össze
 * (pl. percenkénti státuszváltás egy héten át = 10000+ szakasz), ehelyett
 * fix számú, egyenlő szélességű időrésre egyszerűsítjük, mindegyikhez a
 * domináns (leghosszabb ideig tartó) státuszt választva — ez korlátozza
 * a válasz méretét, függetlenül a tényleges állapotváltási sűrűségtől.
 */
export async function getStatusTimeline(machineId: string, from: Date, to: Date): Promise<StatusSegment[]> {
  const result = await pool.query<{ status: string; started_at: string; ended_at: string }>(
    `
    WITH raw_status AS (
      SELECT payload->>'status' AS status, "timestamp" AS started_at,
             LEAD("timestamp") OVER (ORDER BY "timestamp") AS ended_at
      FROM events
      WHERE type = 'machine_status' AND machine_id = $1
    )
    SELECT status,
           GREATEST(started_at, $2::timestamptz) AS started_at,
           LEAST(COALESCE(ended_at, now()), $3::timestamptz) AS ended_at
    FROM raw_status
    WHERE started_at < $3::timestamptz AND COALESCE(ended_at, now()) > $2::timestamptz
    ORDER BY started_at
    `,
    [machineId, from, to],
  );

  const segments: StatusSegment[] = result.rows.map((r) => ({
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  }));

  if (segments.length <= MAX_SEGMENTS) return segments;

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

  const merged: StatusSegment[] = [];
  for (const seg of simplified) {
    const last = merged[merged.length - 1];
    if (last && last.status === seg.status && last.endedAt === seg.startedAt) {
      last.endedAt = seg.endedAt;
    } else {
      merged.push({ ...seg });
    }
  }

  return merged;
}