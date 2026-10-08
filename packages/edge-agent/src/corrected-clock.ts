import { clockAheadMs } from "./clock-check.js";

/**
 * The agent's corrected wall clock (chaos slice 15, findings 26 and 28).
 *
 * A device whose clock is wrong (no real-time clock, dead battery, no time sync) used to
 * stamp its events with the wrong time: a clock behind the server hid real status changes
 * and a clock ahead was clipped by the ingestion guard. The agent now measures its offset
 * against the server (claim and every heartbeat answer carry the server time) and stamps
 * events, counter states and the catch-up age with the corrected time.
 *
 * Only wall-clock stamps are corrected; durations (timers, retries, watchdogs) are not.
 * The heartbeat keeps sending the RAW device time, the backend derives the offset and the
 * `edge_clock_skew` alert from it, so the operator is still told to fix the time sync.
 */

/** Offsets below this are noise (or already fine) and are not corrected. */
export const CORRECTION_MIN_MS = 2_000;
/** A new correction must differ by this much from the current one, else the jitter of the measurement is ignored. */
export const CORRECTION_JITTER_MS = 500;
/** A measurement whose request took longer than this is too inaccurate to use. */
export const MAX_ROUND_TRIP_MS = 5_000;

/** The milliseconds to ADD to the device clock; null = no usable measurement. */
export function correctionFromAhead(aheadMs: number | null): number | null {
  if (aheadMs === null || !Number.isFinite(aheadMs)) return null;
  if (Math.abs(aheadMs) < CORRECTION_MIN_MS) return 0;
  return -Math.round(aheadMs);
}

/** How far the device clock is ahead of the server's (negative = behind); null if the round trip was too slow or the answer unusable. */
export function measureAhead(sentAtMs: number, receivedAtMs: number, serverTimeMs: unknown): number | null {
  if (typeof serverTimeMs !== "number" || !Number.isFinite(serverTimeMs)) return null;
  const roundTrip = receivedAtMs - sentAtMs;
  if (roundTrip < 0 || roundTrip > MAX_ROUND_TRIP_MS) return null;
  return clockAheadMs(sentAtMs, receivedAtMs, serverTimeMs);
}

export interface ClockUpdate {
  changed: boolean;
  previous: number;
  current: number;
}

export class CorrectedClock {
  private offsetMs = 0;

  constructor(private readonly rawNow: () => number = () => Date.now()) {}

  /** The correction currently applied, in ms. */
  get offset(): number {
    return this.offsetMs;
  }

  now(): number {
    return this.rawNow() + this.offsetMs;
  }

  nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Feeds a measurement; null (no measurement) keeps the current correction. */
  update(aheadMs: number | null): ClockUpdate {
    const previous = this.offsetMs;
    const next = correctionFromAhead(aheadMs);
    if (next === null) return { changed: false, previous, current: previous };
    const switchesOnOff = (next === 0) !== (previous === 0);
    if (!switchesOnOff && Math.abs(next - previous) < CORRECTION_JITTER_MS) return { changed: false, previous, current: previous };
    this.offsetMs = next;
    return { changed: next !== previous, previous, current: next };
  }
}

export function clockCorrectionNotice(aheadMs: number): string {
  const seconds = Math.round(Math.abs(aheadMs) / 1000);
  const direction = aheadMs > 0 ? "ahead of" : "behind";
  return `The clock of this device is ${seconds} s ${direction} the server's; event timestamps are corrected with the measured offset. Fix the time synchronisation (NTP, chrony or systemd-timesyncd) anyway.`;
}
