import { randomUUID } from "node:crypto";
import type { MachineEvent } from "@mes/shared";
import { pool } from "./db.js";

const POSTGRES_UNIQUE_VIOLATION = "23505";

export type InsertResult = "inserted" | "duplicate";

/**
 * Persists one event. Relies on the `source_event_id` unique constraint
 * (see sql/001_init.sql) for de-duplication: the edge agent's buffer flush
 * (edge-agent/src/index.ts) can legitimately retry an event that already
 * made it through before a connection dropped mid-flush, and a duplicate
 * insert here is the expected, harmless outcome of that — not an error.
 */
export async function insertEvent(event: MachineEvent): Promise<InsertResult> {
  try {
    await pool.query(
      `INSERT INTO events (id, machine_id, type, "timestamp", source_event_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), event.machineId, event.type, event.timestamp, event.sourceEventId, JSON.stringify(event)],
    );
    return "inserted";
  } catch (err) {
    if (isUniqueViolation(err)) return "duplicate";
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === POSTGRES_UNIQUE_VIOLATION;
}
