import type { FastifyBaseLogger } from "fastify";
import { pool } from "./db.js";
import { config } from "./config.js";
import { rollupMachineStatus } from "./status-rollup-evaluator.js";
import { recomputeProductionCounts } from "./production-rollup-evaluator.js";
import { raiseOrUpdateSystemAlert, resolveSystemAlert } from "./alerts-repository.js";
import { recordAuditEvent } from "./audit-repository.js";

/**
 * A nyers események (events hypertable) megőrzése: a MES_RAW_EVENT_RETENTION_DAYS
 * (alapértelmezés 90) napnál régebbi chunkok törlése drop_chunks-szal.
 * TimescaleDB OSS: a drop_chunks elérhető, az add_retention_policy nem, ezért
 * saját ütemezés.
 *
 * Biztosítékok, chunkonként, a legrégebbitől:
 *  1. Határidő: LEAST(now − megőrzés, legrégebbi nyitott munkarendelés
 *     indulása − 1 nap) — a rendelés haladása a nyers eseményekből számol.
 *     Soha nem újabb, mint now − 7 nap.
 *  2. A chunk időszakára újraszámolja az óránkénti összesítőket
 *     (production_counts_hourly, machine_status_hourly) — egy összesítő-hiba
 *     így a törlés előtt javul, nem vész el (lásd a 2026-09-28-i alulszámolást).
 *     Az állapot-összesítőt a KÖVETKEZŐ chunk első eseményéig is kiterjeszti:
 *     azoknak az óráknak a kiinduló állapota ebből a chunkból jön, így csak
 *     most számolhatók újra.
 *  3. Ellenőrzés: a chunk nyers darabszáma = az összesítő összege. Ha nem, a
 *     chunk NEM törlődik, és a futás hibával zárul (riasztás).
 *  4. drop_chunks, és egy 'raw_events_dropped' audit bejegyzés.
 *
 * Dry run (MES_RAW_EVENT_RETENTION_DRY_RUN, alapértelmezés true): az 1–3.
 * lépés lefut (az összesítők újraszámolása ártalmatlan), a törlés nem —
 * csak naplózza, mit törölne. Minden futás életjelet ír a job_status-ba
 * ('raw_event_retention'); hibánál rendszerriasztás.
 */

const JOB = "raw_event_retention";
const ALERT_TYPE = "raw_event_retention";
const CHECK_INTERVAL_MS = 6 * 3600_000;
const FIRST_RUN_DELAY_MS = 10 * 60_000;
const MIN_AGE_DAYS = 7;

export interface ChunkInfo {
  name: string;
  start: Date;
  end: Date;
}

export interface RetentionResult {
  dryRun: boolean;
  cutoff: string | null;
  dropped: { chunk: string; from: string; to: string }[];
  skipped?: string;
}

async function recordStatus(status: "success" | "failure", error: string | null, detail: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO job_status (name, last_run_at, last_status, last_error, last_success_at, last_detail)
     VALUES ($1, now(), $2, $3, CASE WHEN $2 = 'success' THEN now() END, $4::jsonb)
     ON CONFLICT (name) DO UPDATE SET
       last_run_at = EXCLUDED.last_run_at, last_status = EXCLUDED.last_status, last_error = EXCLUDED.last_error,
       last_success_at = COALESCE(EXCLUDED.last_success_at, job_status.last_success_at), last_detail = EXCLUDED.last_detail`,
    [JOB, status, error, JSON.stringify(detail)],
  );
}

/** A törlési határidő, vagy null, ha a megőrzés ki van kapcsolva. */
export async function computeCutoff(retentionDays: number): Promise<Date | null> {
  if (retentionDays === 0) return null;
  const result = await pool.query<{ cutoff: Date }>(
    `SELECT LEAST(
       now() - make_interval(days => $1),
       now() - make_interval(days => $2),
       COALESCE((
         SELECT min(al.occurred_at) - interval '1 day'
         FROM work_orders wo
         JOIN audit_log al ON al.target = wo.id AND al.action = 'work_order_updated' AND al.details->>'status' = 'in_progress'
         WHERE wo.status = 'in_progress'
       ), 'infinity'::timestamptz)
     ) AS cutoff`,
    [retentionDays, MIN_AGE_DAYS],
  );
  return result.rows[0]!.cutoff;
}

async function listChunksOlderThan(cutoff: Date): Promise<ChunkInfo[]> {
  const result = await pool.query<{ chunk_name: string; range_start: Date; range_end: Date }>(
    `SELECT chunk_name, range_start, range_end FROM timescaledb_information.chunks
     WHERE hypertable_schema = 'public' AND hypertable_name = 'events' AND range_end <= $1
     ORDER BY range_start`,
    [cutoff],
  );
  return result.rows.map((r) => ({ name: r.chunk_name, start: r.range_start, end: r.range_end }));
}

/**
 * A chunk utáni "határórák" vége: minden gép első státuszeseményének órája a
 * chunk vége után, + 1 óra. Ezekben az órákban a kiinduló állapot a chunkból
 * jön — ha most (a chunk törlése előtt) nem számoljuk újra őket, később már
 * nem lehet (a status rollup ekkor érintetlenül hagyja őket).
 */
async function statusRecomputeEnd(chunk: ChunkInfo): Promise<Date> {
  const result = await pool.query<{ ext: Date | null }>(
    `SELECT LEAST(now(), date_trunc('hour', max(first_ts)) + interval '1 hour') AS ext
     FROM (SELECT min("timestamp") AS first_ts FROM events
           WHERE type = 'machine_status' AND "timestamp" >= $1 GROUP BY machine_id) f`,
    [chunk.end],
  );
  const ext = result.rows[0]?.ext;
  return ext && ext > chunk.end ? ext : chunk.end;
}

async function verifyProductionRollup(chunk: ChunkInfo): Promise<{ raw: number; rollup: number }> {
  const result = await pool.query<{ raw: string; rollup: string }>(
    `SELECT
       (SELECT count(*) FROM events WHERE type = 'production_count' AND "timestamp" >= $1 AND "timestamp" < $2) AS raw,
       (SELECT COALESCE(sum(good_count + scrap_count), 0) FROM production_counts_hourly
        WHERE bucket_start >= date_trunc('hour', $1::timestamptz) AND bucket_start < $2) AS rollup`,
    [chunk.start, chunk.end],
  );
  return { raw: Number(result.rows[0]!.raw), rollup: Number(result.rows[0]!.rollup) };
}

export async function runRawEventRetention(
  log: FastifyBaseLogger,
  opts: { retentionDays: number; dryRun: boolean } = { retentionDays: config.rawEventRetentionDays, dryRun: config.rawEventRetentionDryRun },
): Promise<RetentionResult> {
  const cutoff = await computeCutoff(opts.retentionDays);
  if (!cutoff) return { dryRun: opts.dryRun, cutoff: null, dropped: [], skipped: "retention disabled (MES_RAW_EVENT_RETENTION_DAYS=0)" };

  const chunks = await listChunksOlderThan(cutoff);
  const dropped: RetentionResult["dropped"] = [];
  for (const chunk of chunks) {
    // Összesítők a chunk időszakára — a törlés előtt, a nyers adatból.
    await recomputeProductionCounts(chunk.start, chunk.end);
    await rollupMachineStatus(chunk.start, await statusRecomputeEnd(chunk));
    const check = await verifyProductionRollup(chunk);
    if (check.raw !== check.rollup) {
      throw new Error(
        `rollup mismatch for ${chunk.name} (${chunk.start.toISOString()} – ${chunk.end.toISOString()}): ` +
          `${check.raw} raw production events vs ${check.rollup} in production_counts_hourly — chunk NOT dropped`,
      );
    }
    const entry = { chunk: chunk.name, from: chunk.start.toISOString(), to: chunk.end.toISOString() };
    if (opts.dryRun) {
      log.warn({ ...entry, rawProductionEvents: check.raw }, "raw event retention (dry run): would drop chunk");
    } else {
      await pool.query(`SELECT drop_chunks('public.events', older_than => $1::timestamptz)`, [chunk.end]);
      await recordAuditEvent({
        actorEmail: "system:raw-event-retention",
        action: "raw_events_dropped",
        target: chunk.name,
        details: { ...entry, rawProductionEvents: check.raw, retentionDays: opts.retentionDays },
      });
      log.warn(entry, "raw event retention: dropped chunk");
    }
    dropped.push(entry);
  }
  return { dryRun: opts.dryRun, cutoff: cutoff.toISOString(), dropped };
}

export function startRawEventRetentionEvaluator(log: FastifyBaseLogger): void {
  const run = async () => {
    try {
      const result = await runRawEventRetention(log);
      await recordStatus("success", null, result);
      await resolveSystemAlert(ALERT_TYPE);
      if (result.dropped.length > 0 || result.skipped) log.info(result, "raw event retention run finished");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, "raw event retention run failed");
      await recordStatus("failure", message.slice(0, 500), null).catch(() => undefined);
      await raiseOrUpdateSystemAlert(ALERT_TYPE, `Raw-event retention failed: ${message.slice(0, 300)}`).catch(() => undefined);
    }
  };
  log.info(
    { retentionDays: config.rawEventRetentionDays, dryRun: config.rawEventRetentionDryRun },
    config.rawEventRetentionDryRun ? "raw event retention active (DRY RUN — nothing is deleted)" : "raw event retention active",
  );
  setTimeout(() => void run(), FIRST_RUN_DELAY_MS).unref();
  setInterval(() => void run(), CHECK_INTERVAL_MS).unref();
}
