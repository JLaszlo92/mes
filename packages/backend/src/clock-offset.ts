/**
 * Clock offset of an edge node (pure, no database).
 *
 * The agent sends its clock (`clientTimeMs`) with the claim and with every
 * heartbeat; the offset is "device clock minus server clock" in milliseconds,
 * positive = the device is ahead. The network delay (a few ms) is part of the
 * number, which does not matter against a limit of seconds.
 */

/** Above this difference (either direction) the dashboard warns. */
export const CLOCK_WARN_MS = 30_000;

/** null when the agent sent no usable time (agents before v7 send none). */
export function clockOffsetMs(clientTimeMs: unknown, serverNowMs: number): number | null {
  if (typeof clientTimeMs !== "number" || !Number.isFinite(clientTimeMs)) return null;
  const offset = Math.round(clientTimeMs - serverNowMs);
  // A clock stuck in 1970 is a real case (no RTC, no time sync yet) and must be reported, not hidden.
  return Number.isSafeInteger(offset) ? offset : null;
}

export function isClockSkewed(offsetMs: number | null, limitMs: number = CLOCK_WARN_MS): boolean {
  return offsetMs !== null && Math.abs(offsetMs) > limitMs;
}

/** pg returns bigint columns as strings. */
export function parseStoredOffset(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}
