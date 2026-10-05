/**
 * Pure server-side guard for event timestamps (no I/O, unit-testable).
 *
 * The current status of a machine is derived from the event with the latest
 * timestamp. An event stamped in the future (wrong clock on the edge device)
 * would therefore win over every real event until the server time catches up
 * and hide real status changes. An event stamped more than FUTURE_TOLERANCE_MS
 * ahead of the server's receive time is stored with the receive time instead,
 * and keeps the original in payload.timestampCorrected.
 */
export const FUTURE_TOLERANCE_MS = 60_000;

export interface TimestampCorrection {
  originalTimestamp: string;
  aheadMs: number;
  reason: "future";
}

export type GuardedTimestamp = { corrected: false } | { corrected: true; timestamp: string; info: TimestampCorrection };

export function guardEventTimestamp(timestamp: unknown, nowMs: number, toleranceMs: number = FUTURE_TOLERANCE_MS): GuardedTimestamp {
  const ms = timestamp instanceof Date ? timestamp.getTime() : typeof timestamp === "string" || typeof timestamp === "number" ? new Date(timestamp).getTime() : NaN;
  if (!Number.isFinite(ms)) return { corrected: false };
  const aheadMs = Math.round(ms - nowMs);
  if (aheadMs <= toleranceMs) return { corrected: false };
  return {
    corrected: true,
    timestamp: new Date(nowMs).toISOString(),
    info: { originalTimestamp: new Date(ms).toISOString(), aheadMs, reason: "future" },
  };
}
