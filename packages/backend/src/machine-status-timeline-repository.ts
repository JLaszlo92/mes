import { pool } from "./db.js";

export interface StatusSegment {
  status: string;
  startedAt: string;
  endedAt: string;
}

/**
 * Egy adott gép állapot-szakaszait adja vissza [from, to) tartományra,
 * a tartomány határaira vágva (GREATEST/LEAST) — ugyanaz a minta, mint a
 * shift-summary és a downtime-periods lekérdezéseknél.
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
  return result.rows.map((r) => ({ status: r.status, startedAt: r.started_at, endedAt: r.ended_at }));
}