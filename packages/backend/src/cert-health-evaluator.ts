import type { FastifyBaseLogger } from "fastify";
import { pool } from "./db.js";
import { raiseOrUpdateSystemAlert, resolveSystemAlert } from "./alerts-repository.js";
import { assessCertHealth, type CertStatusRow } from "./cert-health.js";

/**
 * Certificate expiry monitoring, "heartbeat" style like backup-health-evaluator.ts.
 *
 * ops/monitoring/mes-cert-check.sh (mes-cert-check.timer, daily on node-dc)
 * records its result in job_status (name: cert_expiry). This evaluator raises
 * a system alert when
 *  - the last check failed (a certificate expires within 30 days, has expired
 *    or cannot be read; the message lists them), or
 *  - no check ran for STALE_AFTER_MS (timer stopped, script broken) — so a
 *    silent monitor is itself noticed.
 * It resolves the alert when the next check is clean.
 *
 * Scope: only the certificates on node-dc. Certificates of other nodes are
 * tracked on the admin laptop (mes-ca.sh status / ics).
 */

export const CERT_JOB = "cert_expiry";
export const CERT_ALERT_TYPE = "cert_health";

const CHECK_INTERVAL_MS = 10 * 60 * 1000;

export async function checkCertHealth(log: FastifyBaseLogger, now: Date = new Date()): Promise<void> {
  const result = await pool.query<CertStatusRow>(
    `SELECT last_run_at, last_status, last_error FROM job_status WHERE name = $1`,
    [CERT_JOB],
  );
  const health = assessCertHealth(result.rows[0], now);

  if (health.healthy) {
    if (await resolveSystemAlert(CERT_ALERT_TYPE)) log.info("certificate health restored — alert resolved");
    return;
  }
  if (await raiseOrUpdateSystemAlert(CERT_ALERT_TYPE, health.message)) {
    log.warn({ reason: health.message }, "certificate health alert raised");
  }
}

export function startCertHealthEvaluator(log: FastifyBaseLogger): void {
  const run = () => {
    checkCertHealth(log).catch((err) => log.error({ err }, "certificate health check failed"));
  };
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}
