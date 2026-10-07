import { isCertExpiring, warnDaysFromEnv } from "./edge-cert-health.js";

const DAY_MS = 86_400_000;
/** A certificate expiry outside this range is a wrong report, not a date. */
const MIN_EXPIRY_MS = Date.UTC(2000, 0, 1);
const MAX_EXPIRY_MS = Date.UTC(2200, 0, 1);

/**
 * The client certificate figure an agent (v10 and later) sends with the claim
 * and the heartbeat: `{ expiresAtMs }`. Anything else (an older agent sends
 * nothing, a device without a certificate neither) gives null.
 */
export function parseClientCertReport(value: unknown): Date | null {
  if (typeof value !== "object" || value === null) return null;
  const { expiresAtMs } = value as Record<string, unknown>;
  if (typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs)) return null;
  if (expiresAtMs < MIN_EXPIRY_MS || expiresAtMs > MAX_EXPIRY_MS) return null;
  return new Date(Math.round(expiresAtMs));
}

/** A stored timestamptz arrives from pg as a Date (or a string). */
export function storedExpiryMs(value: unknown): number | null {
  const ms = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** The client certificate fields of an edge node as the API returns them. */
export function clientCertView(
  raw: unknown,
  nowMs: number,
  warnDays: number = warnDaysFromEnv(),
): { clientCertExpiresAt: string | null; clientCertDaysLeft: number | null; clientCertExpiring: boolean } {
  const ms = storedExpiryMs(raw);
  if (ms === null) return { clientCertExpiresAt: null, clientCertDaysLeft: null, clientCertExpiring: false };
  return {
    clientCertExpiresAt: new Date(ms).toISOString(),
    clientCertDaysLeft: Math.floor((ms - nowMs) / DAY_MS),
    clientCertExpiring: isCertExpiring(ms, nowMs, warnDays),
  };
}
