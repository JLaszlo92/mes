import type { FastifyBaseLogger } from "fastify";
import { pool } from "./db.js";

const EVAL_INTERVAL_MS = 60_000;

/**
 * Minden lezárult "down" periódust rögzít a downtime_periods táblában —
 * ID-nak a gép+kezdés hash-ét használva (md5), hogy ne kelljen pgcrypto
 * kiterjesztés a random UUID-hoz, és az ismétlődő futás természetesen
 * idempotens legyen (ON CONFLICT DO NOTHING).
 */
async function tick(): Promise<void> {
  await pool.query(`
    INSERT INTO downtime_periods (id, machine_id, started_at, ended_at, duration_seconds)
    SELECT
      md5(machine_id || started_at::text),
      machine_id, started_at, ended_at,
      EXTRACT(EPOCH FROM (ended_at - started_at))
    FROM (
      SELECT machine_id, payload->>'status' AS status, "timestamp" AS started_at,
             LEAD("timestamp") OVER (PARTITION BY machine_id ORDER BY "timestamp") AS ended_at
      FROM events
      WHERE type = 'machine_status'
    ) t
    WHERE status = 'down' AND ended_at IS NOT NULL
    ON CONFLICT (machine_id, started_at) DO NOTHING
  `);
}

export function startDowntimeEvaluator(log: FastifyBaseLogger): void {
  const run = async () => {
    try {
      await tick();
    } catch (err) {
      log.error({ err }, "downtime evaluator tick failed");
    }
  };
  setInterval(() => void run(), EVAL_INTERVAL_MS);
  void run();
}