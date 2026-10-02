/**
 * Pure certificate-health decision logic (no I/O, no db import, so it can be
 * unit-tested without DATABASE_URL). Used by cert-health-evaluator.ts.
 */

/** Daily check + 10 min random delay + margin for a weekend downtime. */
export const CERT_STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

export interface CertStatusRow {
  last_run_at: Date;
  last_status: "success" | "failure";
  last_error: string | null;
}

export type CertHealth = { healthy: true } | { healthy: false; message: string };

function formatUtc(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Pure decision logic (testable): what is the certificate health now? */
export function assessCertHealth(row: CertStatusRow | undefined, now: Date): CertHealth {
  if (!row) {
    return {
      healthy: false,
      message: "No certificate expiry check has been recorded yet — install mes-cert-check.timer on node-dc (ops/monitoring).",
    };
  }
  if (row.last_status === "failure") {
    const reason = row.last_error ?? "the check failed";
    return { healthy: false, message: `Certificate check (${formatUtc(row.last_run_at)}): ${reason}` };
  }
  if (now.getTime() - row.last_run_at.getTime() > CERT_STALE_AFTER_MS) {
    return {
      healthy: false,
      message: `No certificate expiry check since ${formatUtc(row.last_run_at)} — check mes-cert-check.timer on node-dc.`,
    };
  }
  return { healthy: true };
}
