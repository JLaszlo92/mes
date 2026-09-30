import type { FastifyBaseLogger } from "fastify";
import { pool } from "./db.js";

const EVAL_INTERVAL_MS = 5 * 60_000;

/**
 * Ennyi órát számol újra minden futáskor. A késve, az edge agent offline
 * pufferéből érkező státuszesemények is így kerülnek be. A nyers események
 * megőrzési idejének ennél jóval hosszabbnak kell lennie.
 */
export const STATUS_ROLLUP_LOOKBACK_HOURS = 24;

/**
 * Óránkénti státusz-összesítő (machine_status_hourly, sql/035).
 *
 * Egy állapot az eseményétől a gép következő státuszeseményéig tart, a
 * legutolsó a jelen pillanatig — ugyanaz a szemlélet, mint a korábbi
 * üzemóra-számításé. Az órahatáron átnyúló szakaszok órákra bontva
 * kerülnek be. Az ablak elején érvényes állapot a gép ablak előtti utolsó
 * eseményéből jön (gépenként indexelt LIMIT 1), így az ablak első órája is
 * teljes.
 *
 * Az ablakba eső órák sorai egy tranzakcióban cserélődnek (törlés +
 * beszúrás), hogy egy órából kikerült állapot ne maradjon benne.
 */
export async function rollupMachineStatus(windowStart: Date): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM machine_status_hourly WHERE bucket_start >= date_trunc('hour', $1::timestamptz)`, [
      windowStart,
    ]);
    await client.query(
      `
      WITH ws AS (SELECT date_trunc('hour', $1::timestamptz) AS t),
      ev AS (
        SELECT e.machine_id, e."timestamp" AS ts, e.payload->>'status' AS status
        FROM events e, ws
        WHERE e.type = 'machine_status' AND e."timestamp" >= ws.t
        UNION ALL
        SELECT m.id, ws.t, prev.status
        FROM machines m, ws
        CROSS JOIN LATERAL (
          SELECT p.payload->>'status' AS status FROM events p
          WHERE p.machine_id = m.id AND p.type = 'machine_status' AND p."timestamp" < ws.t
          ORDER BY p."timestamp" DESC LIMIT 1
        ) prev
      ),
      iv AS (
        SELECT machine_id, status, ts AS s,
               COALESCE(LEAD(ts) OVER (PARTITION BY machine_id ORDER BY ts), now()) AS e
        FROM ev
      ),
      split AS (
        SELECT iv.machine_id, iv.status, h AS bucket_start,
               GREATEST(iv.s, h) AS s2, LEAST(iv.e, h + interval '1 hour') AS e2
        FROM iv
        CROSS JOIN LATERAL generate_series(date_trunc('hour', iv.s), date_trunc('hour', iv.e), interval '1 hour') h
        WHERE iv.e > iv.s AND iv.status IS NOT NULL
      )
      INSERT INTO machine_status_hourly (machine_id, bucket_start, status, seconds, updated_at)
      SELECT machine_id, bucket_start, status, LEAST(3600, sum(EXTRACT(EPOCH FROM (e2 - s2)))), now()
      FROM split
      WHERE e2 > s2
      GROUP BY machine_id, bucket_start, status
      `,
      [windowStart],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function startStatusRollupEvaluator(log: FastifyBaseLogger): void {
  const run = async (backfill: boolean) => {
    try {
      let windowStart = new Date(Date.now() - STATUS_ROLLUP_LOOKBACK_HOURS * 3600_000);
      if (backfill) {
        // Első indulás (üres összesítő): a teljes meglévő történet, egyszer.
        const empty = await pool.query<{ empty: boolean }>(`SELECT NOT EXISTS (SELECT 1 FROM machine_status_hourly) AS empty`);
        if (empty.rows[0]?.empty) {
          const first = await pool.query<{ first: Date | null }>(
            `SELECT min("timestamp") AS first FROM events WHERE type = 'machine_status'`,
          );
          if (first.rows[0]?.first) {
            windowStart = first.rows[0].first;
            log.info({ from: windowStart }, "status rollup: backfilling full history");
          }
        }
      }
      await rollupMachineStatus(windowStart);
    } catch (err) {
      log.error({ err }, "status rollup evaluator tick failed");
    }
  };
  setInterval(() => void run(false), EVAL_INTERVAL_MS);
  void run(true);
}
