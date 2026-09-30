import type { FastifyBaseLogger } from "fastify";
import { pool } from "./db.js";

const EVAL_INTERVAL_MS = 60_000;

/**
 * Lezárult "down" periódusok rögzítése a downtime_periods táblában.
 *
 * Egy periódus = az első "down" esemény, amelyet NEM "down" előz meg, és az
 * utána következő első nem-"down" esemény közti idő. A közbülső ismétlődő
 * "down" események (pl. egy edge-újracsatlakozás utáni újraküldés) ugyanahhoz
 * a periódushoz tartoznak. Korábban minden "down" esemény külön periódust
 * nyitott a következő eseményig, így egy leállás több darabra hasadhatott.
 *
 * Növekményes: gépenként csak a
 *   LEAST(now() - LOOKBACK, a gép utolsó rögzített periódusának vége)
 * óta érkezett eseményeket nézi. A LOOKBACK a késve, az edge agent offline
 * pufferéből érkező eseményeket fedi le; a LEAST biztosítja, hogy egy
 * LOOKBACK-nél hosszabb, épp most véget érő leállás is bekerüljön. Az
 * előző és a következő esemény indexelt, gépenkénti LIMIT 1 lekérdezés.
 * Korábban percenként a teljes eseménytörténetet végigolvasta.
 *
 * Idempotens: az id a gép + kezdés md5-je, ütközésnél DO NOTHING. Egy még
 * tartó leállás csak akkor kerül be, amikor véget ér.
 */
const LOOKBACK = "48 hours";

export async function evaluateDowntimePeriods(): Promise<void> {
  // 1) Gépenkénti kezdőpont, külön lekérdezésben. (Egy CTE-be ágyazva az
  //    optimalizáló minden eseménysorra újraszámolta — 120k eseménynél
  //    percekig tartott egy futás.) A legutóbbi periódus vége a
  //    (machine_id, started_at) egyedi indexen LIMIT 1-gyel olvasható,
  //    mert a periódusok nem fedik egymást.
  const machines = await pool.query<{ id: string; since: Date }>(
    `SELECT m.id,
            LEAST(now() - $1::interval,
                  COALESCE((SELECT d.ended_at FROM downtime_periods d
                            WHERE d.machine_id = m.id ORDER BY d.started_at DESC LIMIT 1),
                           '-infinity'::timestamptz)) AS since
     FROM machines m`,
    [LOOKBACK],
  );

  // 2) Gépenként, konkrét időponttal: az események az
  //    (machine_id, type, timestamp) index időtartományán olvashatók.
  for (const { id, since } of machines.rows) {
    await pool.query(
      `
      INSERT INTO downtime_periods (id, machine_id, started_at, ended_at, duration_seconds)
      SELECT md5(st.machine_id || st.started_at::text), st.machine_id, st.started_at, fin.ended_at,
             EXTRACT(EPOCH FROM (fin.ended_at - st.started_at))
      FROM (
        SELECT ev.machine_id, ev."timestamp" AS started_at
        FROM events ev
        WHERE ev.machine_id = $1
          AND ev.type = 'machine_status'
          AND ev."timestamp" >= $2
          AND ev.payload->>'status' = 'down'
          AND COALESCE((
            SELECT p.payload->>'status' FROM events p
            WHERE p.machine_id = ev.machine_id AND p.type = 'machine_status' AND p."timestamp" < ev."timestamp"
            ORDER BY p."timestamp" DESC LIMIT 1
          ), '') <> 'down'
      ) st
      CROSS JOIN LATERAL (
        SELECT n."timestamp" AS ended_at FROM events n
        WHERE n.machine_id = st.machine_id AND n.type = 'machine_status'
          AND n."timestamp" > st.started_at AND n.payload->>'status' <> 'down'
        ORDER BY n."timestamp" LIMIT 1
      ) fin
      ON CONFLICT (machine_id, started_at) DO NOTHING
      `,
      [id, since],
    );
  }
}

export function startDowntimeEvaluator(log: FastifyBaseLogger): void {
  const run = async () => {
    try {
      await evaluateDowntimePeriods();
    } catch (err) {
      log.error({ err }, "downtime evaluator tick failed");
    }
  };
  setInterval(() => void run(), EVAL_INTERVAL_MS);
  void run();
}
