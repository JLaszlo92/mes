import type { FastifyBaseLogger } from "fastify";
import { pool } from "./db.js";

const EVAL_INTERVAL_MS = 5 * 60_000; // 5 percenként

/**
 * Csak a legutóbbi néhány órát számolja újra (nem az egész történetet) —
 * ez fedezi a késve érkező (pufferelt) eseményeket is, miközben olcsó
 * marad, mert csak egy szűk, friss ablakot pásztáz végig, nem az összes
 * nyers eseményt.
 */
async function tick(): Promise<void> {
  await pool.query(`
    INSERT INTO production_counts_hourly (machine_id, bucket_start, good_count, scrap_count, updated_at)
    SELECT
      machine_id,
      date_trunc('hour', "timestamp") AS bucket_start,
      COUNT(*) FILTER (WHERE payload->>'result' = 'good'),
      COUNT(*) FILTER (WHERE payload->>'result' = 'scrap'),
      now()
    FROM events
    WHERE type = 'production_count' AND "timestamp" >= now() - INTERVAL '3 hours'
    GROUP BY machine_id, date_trunc('hour', "timestamp")
    ON CONFLICT (machine_id, bucket_start) DO UPDATE SET
      good_count = EXCLUDED.good_count,
      scrap_count = EXCLUDED.scrap_count,
      updated_at = EXCLUDED.updated_at
  `);
}

export function startProductionRollupEvaluator(log: FastifyBaseLogger): void {
  const run = async () => {
    try {
      await tick();
    } catch (err) {
      log.error({ err }, "production rollup evaluator tick failed");
    }
  };
  setInterval(() => void run(), EVAL_INTERVAL_MS);
  void run();
}