import type { FastifyBaseLogger } from "fastify";
import { pool } from "./db.js";

const EVAL_INTERVAL_MS = 5 * 60_000; // 5 percenként

/**
 * Óránkénti darabszám-összesítő (production_counts_hourly).
 *
 * Az ablak ÓRAHATÁRON kezdődik (date_trunc): korábban now() - 3 h-tól
 * számolt, így az ablak legrégebbi órájából csak a vége került bele, és a
 * DO UPDATE ezzel a kisebb számmal írta felül a helyes értéket — minden óra
 * torzult (2026-09-28 óta). Az utolsó 24 órát számolja újra, hogy egy napon
 * belüli backend-kiesés alatt pufferelt események is pótlódjanak.
 * Szabály: egy összesítő, amely felülírja az óráit, csak TELJES órákat
 * számolhat újra.
 */
export async function recomputeProductionCounts(from: Date, to?: Date): Promise<void> {
  await pool.query(
    `
    INSERT INTO production_counts_hourly (machine_id, bucket_start, good_count, scrap_count, updated_at)
    SELECT
      e.machine_id,
      date_trunc('hour', e."timestamp") AS bucket_start,
      COUNT(*) FILTER (WHERE e.payload->>'result' = 'good'),
      COUNT(*) FILTER (WHERE e.payload->>'result' = 'scrap'),
      now()
    FROM events e
    JOIN machines m ON m.id = e.machine_id
    WHERE e.type = 'production_count'
      AND e."timestamp" >= date_trunc('hour', $1::timestamptz)
      AND ($2::timestamptz IS NULL OR e."timestamp" < date_trunc('hour', $2::timestamptz))
    GROUP BY e.machine_id, date_trunc('hour', e."timestamp")
    ON CONFLICT (machine_id, bucket_start) DO UPDATE SET
      good_count = EXCLUDED.good_count,
      scrap_count = EXCLUDED.scrap_count,
      updated_at = EXCLUDED.updated_at
    `,
    [from, to ?? null],
  );
}

async function tick(): Promise<void> {
  await recomputeProductionCounts(new Date(Date.now() - 24 * 3600_000));
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
