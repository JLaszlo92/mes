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
      `INSERT INTO events (id, machine_id, type, "timestamp", source_event_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [randomUUID(), event.machineId, event.type, guarded.corrected ? guarded.timestamp : event.timestamp, event.sourceEventId, JSON.stringify(stored)],
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
