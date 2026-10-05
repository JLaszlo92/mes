/**
 * Decides how many production counts to book when a counter source is read
 * for the first time after a gap in observation: an edge agent restart, or a
 * lost connection to the PLC. Pure (no I/O), so it is unit-tested.
 *
 * Rule (decided Oct 5, 2026): parts produced while we were not looking are
 * booked afterwards, but only when the gap is short (default 10 minutes,
 * set per edge node). Event timestamps are the time of emission, not of
 * production, so crediting a long gap would put the parts into the wrong
 * hour and shift. Longer gaps are dropped and reported in the log.
 */

export interface CounterSnapshot {
  good: number;
  scrap: number;
}

export interface StoredCounters extends CounterSnapshot {
  /** Time of the last successful reading, ms since the epoch. */
  seenAtMs: number;
}

export type CatchupNote =
  | "first_start" // no earlier values known: start from the current ones
  | "no_gap" // nothing was produced while we were away
  | "caught_up" // the missed parts are booked now
  | "too_old" // the gap is longer than allowed: not booked
  | "too_large" // implausibly many parts: not booked
  | "counter_reset" // a counter went backwards (PLC restart): new baseline
  | "disabled"; // catch-up switched off (limit 0): not booked

export interface CatchupPlan {
  emit: CounterSnapshot;
  lost: CounterSnapshot;
  note: CatchupNote;
  ageMs: number | null;
}

/** Upper bound for one catch-up; a bigger jump is more likely a wrong register than real production. */
export const MAX_CATCHUP_PARTS = 5000;

const ZERO: CounterSnapshot = { good: 0, scrap: 0 };

export function planCatchup(
  stored: StoredCounters | null,
  current: CounterSnapshot,
  nowMs: number,
  maxAgeMs: number,
): CatchupPlan {
  if (!stored) return { emit: ZERO, lost: ZERO, note: "first_start", ageMs: null };

  const ageMs = nowMs - stored.seenAtMs;

  if (current.good < stored.good || current.scrap < stored.scrap) {
    return { emit: ZERO, lost: ZERO, note: "counter_reset", ageMs };
  }

  const delta: CounterSnapshot = { good: current.good - stored.good, scrap: current.scrap - stored.scrap };
  if (delta.good === 0 && delta.scrap === 0) return { emit: ZERO, lost: ZERO, note: "no_gap", ageMs };

  if (maxAgeMs <= 0) return { emit: ZERO, lost: delta, note: "disabled", ageMs };
  // A negative age means the clock was set back: the length of the gap is unknown.
  if (ageMs < 0 || ageMs > maxAgeMs) return { emit: ZERO, lost: delta, note: "too_old", ageMs };
  if (delta.good + delta.scrap > MAX_CATCHUP_PARTS) return { emit: ZERO, lost: delta, note: "too_large", ageMs };

  return { emit: delta, lost: ZERO, note: "caught_up", ageMs };
}
