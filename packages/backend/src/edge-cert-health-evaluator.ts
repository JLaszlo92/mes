import type { FastifyBaseLogger } from "fastify";
import { pool } from "./db.js";
import { raiseOrUpdateSystemAlert, resolveSystemAlert } from "./alerts-repository.js";
import { storedExpiryMs } from "./client-cert-report.js";
import { EDGE_CERT_ALERT_TYPE, assessEdgeCerts, warnDaysFromEnv, type EdgeCertRow } from "./edge-cert-health.js";

/**
 * Raises one system alert while the client certificate of an edge node expires
 * within the warning period (30 days, EDGE_CERT_WARN_DAYS) or has expired, and
 * resolves it once every reported certificate is further away (a renewed
 * certificate is reported when the agent starts with it). The expiry comes from
 * the agent's claim and heartbeat (v10 and later), see client-cert-report.ts.
 */

const CHECK_INTERVAL_MS = 10 * 60 * 1000;

export function createEdgeCertCheck(
  log: FastifyBaseLogger,
  warnDays: number = warnDaysFromEnv(),
  now: () => number = Date.now,
): () => Promise<void> {
  return async () => {
    const result = await pool.query<{ name: string; client_cert_expires_at: Date | string | null }>(
      `SELECT name, client_cert_expires_at
         FROM edge_nodes
        WHERE client_cert_expires_at IS NOT NULL
        ORDER BY name`,
    );
    const rows: EdgeCertRow[] = result.rows.map((r) => ({ name: r.name, expiresAtMs: storedExpiryMs(r.client_cert_expires_at) }));
    const health = assessEdgeCerts(rows, now(), warnDays);

    if (health.healthy) {
      if (await resolveSystemAlert(EDGE_CERT_ALERT_TYPE)) log.info("edge node client certificates are valid again — alert resolved");
      return;
    }
    if (await raiseOrUpdateSystemAlert(EDGE_CERT_ALERT_TYPE, health.message)) {
      log.warn({ reason: health.message }, "edge node client certificate alert raised");
    }
  };
}

export function startEdgeCertEvaluator(log: FastifyBaseLogger): void {
  const check = createEdgeCertCheck(log);
  const run = () => {
    check().catch((err) => log.error({ err }, "edge node client certificate check failed"));
  };
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}
