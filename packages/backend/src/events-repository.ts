import { randomUUID } from "node:crypto";
import type { MachineEvent } from "@mes/shared";
import { pool } from "./db.js";
import { guardEventTimestamp, type TimestampCorrection } from "./event-timestamp-guard.js";

const POSTGRES_UNIQUE_VIOLATION = "23505";

export type InsertResult = "inserted" | "duplicate";

/**
 * Persists one event. Relies on the `source_event_id` unique constraint
 * (see sql/001_init.sql) for de-duplication: the edge agent's buffer flush
 * (edge-agent/src/index.ts) can legitimately retry an event that already
 * made it through before a connection dropped mid-flush, and a duplicate
 * insert here is the expected, harmless outcome of that — not an error.
 *
 * The unique index is (source_event_id, "timestamp"), and the ingestion guard replaces the
 * timestamp of an event stamped far in the future with the receive time. A resend of such an
 * event therefore carries a different timestamp than the stored row and would not conflict.
 * The ids of corrected events are kept in event_timestamp_corrections (sql/044), written in the
 * same statement as the event, and an event whose id is listed there is skipped.
 */
export async function insertEvent(
  event: MachineEvent,
  onCorrected?: (info: TimestampCorrection) => void,
  nowMs: number = Date.now(),
): Promise<InsertResult> {
  // An event stamped in the future would win the "latest event" status lookup (event-timestamp-guard.ts).
  const guarded = guardEventTimestamp(event.timestamp, nowMs);
  const stored = guarded.corrected ? { ...event, timestamp: guarded.timestamp, timestampCorrected: guarded.info } : event;
  try {
    const result = await pool.query(
      `WITH ins AS (
         INSERT INTO events (id, machine_id, type, "timestamp", source_event_id, payload)
         SELECT $1::text, $2::text, $3::text, $4::timestamptz, $5::text, $6::jsonb
         WHERE NOT EXISTS (SELECT 1 FROM event_timestamp_corrections WHERE source_event_id = $5::text)
         ON CONFLICT DO NOTHING
         RETURNING source_event_id
       ), marker AS (
         INSERT INTO event_timestamp_corrections (source_event_id)
         SELECT source_event_id FROM ins WHERE $7::boolean
         ON CONFLICT DO NOTHING
       )
       SELECT 1 FROM ins`,
      [randomUUID(), event.machineId, event.type, guarded.corrected ? guarded.timestamp : event.timestamp, event.sourceEventId, JSON.stringify(stored), guarded.corrected],
    );
    // A conflicting row is skipped by the database: no exception, no error line in the
    // Postgres log (the edge agent's retries used to cost ~2000 of them per outage).
    if (result?.rowCount === 0) return "duplicate";
    if (guarded.corrected) onCorrected?.(guarded.info);
    return "inserted";
  } catch (err) {
    if (isUniqueViolation(err)) return "duplicate";
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === POSTGRES_UNIQUE_VIOLATION;
}
