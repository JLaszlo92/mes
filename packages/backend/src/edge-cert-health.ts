/**
 * Pure decision logic for the edge client certificate alert (no I/O, no db
 * import, so it can be unit-tested without DATABASE_URL). Used by
 * edge-cert-health-evaluator.ts and the Edge nodes list.
 *
 * Every edge device connects to the broker with its own client certificate
 * (valid one year). An expired one stops that device from connecting; it keeps
 * buffering on its disk but nothing reaches the server. The agent (v10 and
 * later) reports the expiry of the certificate it loaded; the alert lists the
 * nodes whose certificate expires within the warning period or has expired.
 * Unlike the clock and disk alerts, an offline node is NOT ignored: a node that
 * is offline because its certificate expired is exactly the case to report.
 */

export const EDGE_CERT_ALERT_TYPE = "edge_cert_expiry";
export const DEFAULT_EDGE_CERT_WARN_DAYS = 30;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_LISTED = 5;

/** EDGE_CERT_WARN_DAYS (1 to 3650); anything else gives the default. */
export function warnDaysFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.EDGE_CERT_WARN_DAYS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_EDGE_CERT_WARN_DAYS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : DEFAULT_EDGE_CERT_WARN_DAYS;
}

export function isCertExpiring(expiresAtMs: number, nowMs: number, warnDays: number = DEFAULT_EDGE_CERT_WARN_DAYS): boolean {
  return expiresAtMs - nowMs <= warnDays * DAY_MS;
}

/** "expires in 12 days", "expires in 5 h", "expires within the hour", "expired 3 days ago", ... */
export function describeCertLeft(msLeft: number): string {
  if (msLeft >= 0) {
    if (msLeft < HOUR_MS) return "expires within the hour";
    if (msLeft < 48 * HOUR_MS) return `expires in ${Math.round(msLeft / HOUR_MS)} h`;
    return `expires in ${Math.round(msLeft / DAY_MS)} days`;
  }
  const ago = -msLeft;
  if (ago < HOUR_MS) return "expired less than an hour ago";
  if (ago < 48 * HOUR_MS) return `expired ${Math.round(ago / HOUR_MS)} h ago`;
  return `expired ${Math.round(ago / DAY_MS)} days ago`;
}

export interface EdgeCertRow {
  name: string;
  /** Expiry of the client certificate; null = never reported (agent older than v10). */
  expiresAtMs: number | null;
}

export type EdgeCertHealth = { healthy: true } | { healthy: false; message: string };

export function assessEdgeCerts(rows: readonly EdgeCertRow[], nowMs: number, warnDays: number = DEFAULT_EDGE_CERT_WARN_DAYS): EdgeCertHealth {
  const due = rows
    .filter((r): r is { name: string; expiresAtMs: number } => r.expiresAtMs !== null && isCertExpiring(r.expiresAtMs, nowMs, warnDays))
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs);
  if (due.length === 0) return { healthy: true };

  const listed = due
    .slice(0, MAX_LISTED)
    .map((r) => `${r.name} (${describeCertLeft(r.expiresAtMs - nowMs)})`)
    .join(", ");
  const more = due.length > MAX_LISTED ? ` and ${due.length - MAX_LISTED} more` : "";
  const noun = due.length === 1 ? "edge node" : "edge nodes";
  return {
    healthy: false,
    message:
      `The client certificate of ${due.length} ${noun} expires within ${warnDays} days or has expired: ${listed}${more}. ` +
      `A device with an expired certificate cannot connect to the broker; it keeps buffering events on its disk until the certificate is renewed ` +
      `(issue a new one with mes-ca.sh issue-device, install it on the device and restart the agent).`,
  };
}
