import type { MachineEvent } from "@mes/shared";

/** An event is not published again for this long after it was sent (acks normally arrive within a second). */
export const RETRY_MIN_AGE_MS = 15_000;
/** At most this many events are published per sweep, so a long backlog is sent in portions. */
export const RETRY_MAX_BATCH = 300;

/**
 * Decides which buffered events a retry sweep publishes. Without it every sweep
 * (every 4 s) republished the whole buffer, so while the backend was still working
 * through a backlog the same events arrived again and again (chaos slice 12: about
 * 2000 duplicates for 350 events, 30 s of 45 % CPU on the backend). Now an event is
 * sent once, sent again only when no ack came within RETRY_MIN_AGE_MS, and a sweep
 * sends a bounded portion, oldest first. reset() forgets what was sent (call it on
 * every (re)connect: nothing sent before is in flight any more).
 */
export class RetryTracker {
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly minAgeMs: number = RETRY_MIN_AGE_MS,
    private readonly maxBatch: number = RETRY_MAX_BATCH,
    private readonly now: () => number = Date.now,
  ) {}

  /** The part of `pending` to publish now; those events are recorded as sent. */
  select(pending: readonly MachineEvent[]): MachineEvent[] {
    const t = this.now();
    const live = new Set(pending.map((e) => e.sourceEventId));
    for (const id of this.lastSent.keys()) {
      if (!live.has(id)) this.lastSent.delete(id); // acked and removed from the buffer
    }
    const batch: MachineEvent[] = [];
    for (const event of pending) {
      if (batch.length >= this.maxBatch) break;
      const last = this.lastSent.get(event.sourceEventId);
      if (last !== undefined && t - last < this.minAgeMs) continue;
      batch.push(event);
      this.lastSent.set(event.sourceEventId, t);
    }
    return batch;
  }

  reset(): void {
    this.lastSent.clear();
  }
}
