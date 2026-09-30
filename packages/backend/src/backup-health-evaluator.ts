import type { FastifyBaseLogger } from "fastify";
import { pool } from "./db.js";
import { raiseOrUpdateSystemAlert, resolveSystemAlert } from "./alerts-repository.js";

/**
 * Mentés-figyelés "életjel" alapon (dead man's switch).
 *
 * A mes-backup.sh minden futás végén beírja az eredményét a job_status
 * táblába (sql/031). Ez az evaluator riaszt, ha
 *  - a legutóbbi futás sikertelen volt (azonnal, a hiba okával), vagy
 *  - STALE_AFTER_MS óta nem volt sikeres mentés — akkor is, ha a mentés le
 *    sem futott (timer kikapcsolva, gép állt, a szkript el sem indult), amit
 *    egy systemd OnFailure= hook sosem venne észre.
 * Ha minden rendben, a nyitott mentési riasztást lezárja.
 *
 * Korlát: ha a node-dc maga áll, ez az evaluator sem fut — azt csak egy
 * külső figyelő venné észre (lásd docs/SECURITY_REVIEW.md 8.8).
 */

export const BACKUP_JOB = "db_backup";
export const BACKUP_ALERT_TYPE = "backup_health";

/** Napi mentés + 10 perc véletlen késleltetés + tartalék. */
const STALE_AFTER_MS = 26 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

export interface BackupStatusRow {
  last_run_at: Date;
  last_status: "success" | "failure";
  last_error: string | null;
  last_success_at: Date | null;
}

export type BackupHealth = { healthy: true } | { healthy: false; message: string };

function formatUtc(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Tiszta döntési logika (tesztelhető): mi a mentés állapota most? */
export function assessBackupHealth(row: BackupStatusRow | undefined, now: Date): BackupHealth {
  if (!row) {
    return { healthy: false, message: "No database backup has been recorded yet." };
  }
  if (row.last_status === "failure") {
    const reason = row.last_error ? `: ${row.last_error}` : "";
    return { healthy: false, message: `Database backup failed at ${formatUtc(row.last_run_at)}${reason}` };
  }
  if (!row.last_success_at || now.getTime() - row.last_success_at.getTime() > STALE_AFTER_MS) {
    const since = row.last_success_at ? `since ${formatUtc(row.last_success_at)}` : "recorded";
    return { healthy: false, message: `No successful database backup ${since} — check mes-backup.timer on node-dc.` };
  }
  return { healthy: true };
}

export async function checkBackupHealth(log: FastifyBaseLogger, now: Date = new Date()): Promise<void> {
  const result = await pool.query<BackupStatusRow>(
    `SELECT last_run_at, last_status, last_error, last_success_at FROM job_status WHERE name = $1`,
    [BACKUP_JOB],
  );
  const health = assessBackupHealth(result.rows[0], now);

  if (health.healthy) {
    if (await resolveSystemAlert(BACKUP_ALERT_TYPE)) log.info("backup health restored — alert resolved");
    return;
  }
  if (await raiseOrUpdateSystemAlert(BACKUP_ALERT_TYPE, health.message)) {
    log.warn({ reason: health.message }, "backup health alert raised");
  }
}

export function startBackupHealthEvaluator(log: FastifyBaseLogger): void {
  const run = () => {
    checkBackupHealth(log).catch((err) => log.error({ err }, "backup health check failed"));
  };
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}
