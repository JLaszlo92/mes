/**
 * The agent's own check of its clock against the server (pure).
 * The claim response carries the server time; one request/response pair gives
 * the offset (the middle of the request is compared with the server's time).
 */

/** Same limit as the dashboard's warning. */
export const CLOCK_WARN_MS = 30_000;

/** How far the local clock is ahead of the server's (negative = behind). */
export function clockAheadMs(sentAtMs: number, receivedAtMs: number, serverTimeMs: number): number {
  return Math.round((sentAtMs + receivedAtMs) / 2) - serverTimeMs;
}

/** The text to log, or null when the clock is fine or unknown. */
export function clockSkewWarning(aheadMs: number | null, limitMs: number = CLOCK_WARN_MS): string | null {
  if (aheadMs === null || Math.abs(aheadMs) <= limitMs) return null;
  const direction = aheadMs > 0 ? "ahead of" : "behind";
  const seconds = Math.round(Math.abs(aheadMs) / 1000);
  return `The clock of this device is ${seconds} s ${direction} the server's. Event timestamps will be wrong; check the time synchronisation (NTP, chrony or systemd-timesyncd).`;
}
