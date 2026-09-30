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
 * legutolsó a jelen pillanatig (vagy a windowEnd-ig). Az órahatáron átnyúló
 * szakaszok órákra bontva kerülnek be. Az ablak elején érvényes állapot a gép
 * ablak előtti utolsó eseményéből jön (gépenként indexelt LIMIT 1), így az
 * ablak első órája is teljes.
 *
 * Ha egy gépnél ez a kiinduló esemény HIÁNYZIK, de a gépnek az ablak előtt
 * már van összesítője, akkor a nyers adat a megőrzés miatt hiányzik (a
 * korábbi chunk törölve), nem azért, mert a gép most kezdett adatot küldeni.
 * Ilyenkor az ablak első eseményét tartalmazó órát és az előtte lévőket NEM
 * írja felül — azok a korábbi, még a teljes nyers adatból számolt értéküket
 * tartják meg (egy hiányos újraszámolás ezeket elrontaná). Egy teljesen új
 * gép első órája viszont bekerül.
 *
 * Az érintett órák sorai egy tranzakcióban cserélődnek (törlés + beszúrás).
 *
 * windowEnd (opcionális, egész órán): csak a [windowStart, windowEnd) órákat
 * számolja újra — a megőrzési evaluator egy chunk időszakára használja.
 * Enélkül a jelenig.
 */
export async function rollupMachineStatus(windowStart: Date, windowEnd?: Date): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Gépenként: honnantól számolható újra megbízhatóan.
    const valid = await client.query<{ machine_id: string; valid_from: Date | null }>(
      `
      WITH ws AS (
        SELECT date_trunc('hour', $1::timestamptz) AS t,
               COALESCE(date_trunc('hour', $2::timestamptz), now()) AS te
      )
      SELECT m.id AS machine_id,
             CASE
               WHEN prev.ts IS NOT NULL THEN ws.t
               WHEN NOT EXISTS (SELECT 1 FROM machine_status_hourly h WHERE h.machine_id = m.id AND h.bucket_start < ws.t) THEN ws.t
               ELSE (SELECT date_trunc('hour', min(e."timestamp")) + interval '1 hour' FROM events e
                     WHERE e.machine_id = m.id AND e.type = 'machine_status'
                       AND e."timestamp" >= ws.t AND e."timestamp" < ws.te)
             END AS valid_from
      FROM machines m, ws
      LEFT JOIN LATERAL (
        SELECT p."timestamp" AS ts FROM events p
        WHERE p.machine_id = m.id AND p.type = 'machine_status' AND p."timestamp" < ws.t
        ORDER BY p."timestamp" DESC LIMIT 1
      ) prev ON true
      `,
      [windowStart, windowEnd ?? null],
    );
    const ids = valid.rows.filter((r) => r.valid_from !== null).map((r) => r.machine_id);
    const froms = valid.rows.filter((r) => r.valid_from !== null).map((r) => r.valid_from);
    if (ids.length === 0) {
      await client.query("COMMIT");
      return;
    }

    await client.query(
      `DELETE FROM machine_status_hourly h
       USING unnest($1::text[], $2::timestamptz[]) AS v(machine_id, valid_from)
       WHERE h.machine_id = v.machine_id AND h.bucket_start >= v.valid_from
         AND ($3::timestamptz IS NULL OR h.bucket_start < date_trunc('hour', $3::timestamptz))`,
      [ids, froms, windowEnd ?? null],
    );
    await client.query(
      `
      WITH ws AS (
        SELECT date_trunc('hour', $1::timestamptz) AS t,
               COALESCE(date_trunc('hour', $2::timestamptz), now()) AS te
      ),
      v AS (SELECT * FROM unnest($3::text[], $4::timestamptz[]) AS v(machine_id, valid_from)),
      ev AS (
        SELECT e.machine_id, e."timestamp" AS ts, e.payload->>'status' AS status
        FROM events e, ws
        WHERE e.type = 'machine_status' AND e."timestamp" >= ws.t AND e."timestamp" < ws.te
          AND e.machine_id IN (SELECT machine_id FROM v)
        UNION ALL
        SELECT v.machine_id, ws.t, prev.status
        FROM v, ws
        CROSS JOIN LATERAL (
          SELECT p.payload->>'status' AS status FROM events p
          WHERE p.machine_id = v.machine_id AND p.type = 'machine_status' AND p."timestamp" < ws.t
          ORDER BY p."timestamp" DESC LIMIT 1
        ) prev
      ),
      iv AS (
        -- Az ablak utolsó állapota az ablak végéig tart.
        SELECT ev.machine_id, ev.status, ev.ts AS s,
               LEAST(COALESCE(LEAD(ev.ts) OVER (PARTITION BY ev.machine_id ORDER BY ev.ts), now()), ws.te) AS e
        FROM ev, ws
      ),
      split AS (
        SELECT iv.machine_id, iv.status, h AS bucket_start,
               GREATEST(iv.s, h) AS s2, LEAST(iv.e, h + interval '1 hour') AS e2
        FROM iv
        CROSS JOIN LATERAL generate_series(date_trunc('hour', iv.s), date_trunc('hour', iv.e), interval '1 hour') h
        WHERE iv.e > iv.s AND iv.status IS NOT NULL
      )
      INSERT INTO machine_status_hourly (machine_id, bucket_start, status, seconds, updated_at)
      SELECT split.machine_id, split.bucket_start, split.status, LEAST(3600, sum(EXTRACT(EPOCH FROM (split.e2 - split.s2)))), now()
      FROM split
      JOIN v ON v.machine_id = split.machine_id AND split.bucket_start >= v.valid_from
      WHERE split.e2 > split.s2
      GROUP BY split.machine_id, split.bucket_start, split.status
      `,
      [windowStart, windowEnd ?? null, ids, froms],
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
