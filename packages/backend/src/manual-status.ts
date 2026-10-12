import { randomUUID } from "node:crypto";
import type { MachineEvent } from "@mes/shared";
import { pool } from "./db.js";
import { insertEvent } from "./events-repository.js";
import { publishToHub } from "./hub.js";
import { stateStore } from "./state.js";

/**
 * Kézzel beállított gépállapot (terminál → "Státusz").
 *
 * Szabály: a kézi állapot addig érvényes, amíg
 *  - a gép jele újra "running" lesz (a gép termel: egy elfelejtett
 *    "Beállítás" így nem maradhat bent gyártás közben),
 *  - a dolgozó le nem zárja (a gép jelére áll vissza),
 *  - a műszak véget nem ér (off-shift),
 *  - vagy egy másik kézi állapot le nem váltja.
 *
 * Közben a gép többi jele (down, idle…) `machine_status_signal` típusként
 * tárolódik: megmarad a nyers adatban, de minden nézet, összesítő és az OEE
 * a kézi állapotot látja, mert azok a `machine_status` eseményekből dolgoznak.
 */

export interface ManualStatus {
  id: string;
  machineId: string;
  statusCode: string;
  setByName: string | null;
  setAt: string;
  signalStatus: string | null;
}

type Row = {
  id: string;
  machine_id: string;
  status_code: string;
  set_by_name: string | null;
  set_at: string | Date;
  signal_status: string | null;
};

function toManual(r: Row): ManualStatus {
  return {
    id: r.id,
    machineId: r.machine_id,
    statusCode: r.status_code,
    setByName: r.set_by_name,
    setAt: new Date(r.set_at).toISOString(),
    signalStatus: r.signal_status,
  };
}

export async function getActiveManualStatus(machineId: string): Promise<ManualStatus | undefined> {
  const result = await pool.query<Row>(`SELECT * FROM machine_manual_status WHERE machine_id = $1 AND ended_at IS NULL`, [machineId]);
  return result.rows[0] ? toManual(result.rows[0]) : undefined;
}

export type SignalDecision =
  /** No manual status: the machine's signal is the status, as always. */
  | "apply"
  /** A buffered event from before the manual status: history, stored as it is, but not the live state. */
  | "history"
  /** The machine runs again: the manual status ends and the signal is the status. */
  | "apply_and_end"
  /** Kept as a signal only (machine_status_signal); the manual status stays. */
  | "suppress";

/** Pure: what a machine_status event from the machine means while a manual status may be active. */
export function decideSignal(manual: Pick<ManualStatus, "setAt"> | undefined, event: { status: string; timestamp: string }): SignalDecision {
  if (!manual) return "apply";
  if (new Date(event.timestamp).getTime() <= new Date(manual.setAt).getTime()) return "history";
  if (event.status === "running") return "apply_and_end";
  return "suppress";
}

async function emitStatus(machineId: string, status: string, extra: Record<string, unknown>): Promise<MachineEvent> {
  const event = {
    machineId,
    timestamp: new Date().toISOString(),
    sourceEventId: randomUUID(),
    type: "machine_status" as const,
    status,
    ...extra,
  };
  await insertEvent(event);
  stateStore.applyEvent(event);
  publishToHub(event);
  return event;
}

/** The status the machine's own signal last reported (for a manual status that starts now). */
async function lastSignalStatus(machineId: string): Promise<string | null> {
  const result = await pool.query<{ status: string | null }>(
    `SELECT payload->>'status' AS status FROM events
     WHERE machine_id = $1 AND type IN ('machine_status', 'machine_status_signal') AND COALESCE(payload->>'source', 'machine') = 'machine'
     ORDER BY "timestamp" DESC LIMIT 1`,
    [machineId],
  );
  return result.rows[0]?.status ?? null;
}

/**
 * Sets a manual status (ending an earlier one as "replaced"). Writes the
 * machine_status event, so the live view and every report see it at once.
 */
export async function setManualStatus(input: { machineId: string; statusCode: string; userId: string; userName: string; terminalId: string }): Promise<ManualStatus> {
  const previous = await getActiveManualStatus(input.machineId);
  const signal = previous ? previous.signalStatus : await lastSignalStatus(input.machineId);
  const client = await pool.connect();
  let created: ManualStatus;
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE machine_manual_status SET ended_at = now(), end_reason = 'replaced', ended_by = $2 WHERE machine_id = $1 AND ended_at IS NULL`, [
      input.machineId,
      input.userId,
    ]);
    const result = await client.query<Row>(
      `INSERT INTO machine_manual_status (id, machine_id, status_code, set_by, set_by_name, terminal_id, signal_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [randomUUID(), input.machineId, input.statusCode, input.userId, input.userName, input.terminalId, signal],
    );
    await client.query("COMMIT");
    created = toManual(result.rows[0]!);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await emitStatus(input.machineId, input.statusCode, { source: "terminal", setBy: input.userName });
  return created;
}

/**
 * Ends the active manual status. For the operator and the end of a shift the
 * machine goes back to what its signal last said (a machine_status event);
 * for "signal_running" the incoming running event is that status already.
 */
export async function endManualStatus(
  machineId: string,
  reason: "operator" | "signal_running" | "off_shift",
  userId: string | null = null,
): Promise<ManualStatus | undefined> {
  const result = await pool.query<Row>(
    `UPDATE machine_manual_status SET ended_at = now(), end_reason = $2, ended_by = $3
     WHERE machine_id = $1 AND ended_at IS NULL RETURNING *`,
    [machineId, reason, userId],
  );
  const ended = result.rows[0] ? toManual(result.rows[0]) : undefined;
  if (ended && reason === "operator" && ended.signalStatus) {
    await emitStatus(machineId, ended.signalStatus, { source: "manual_end" });
  }
  return ended;
}

/** A suppressed signal: kept as data, and remembered as the status to go back to. */
export async function recordSuppressedSignal(event: MachineEvent & { type: "machine_status" }): Promise<"inserted" | "duplicate"> {
  const stored = { ...event, type: "machine_status_signal" } as unknown as MachineEvent;
  const outcome = await insertEvent(stored);
  if (outcome === "inserted") {
    await pool.query(`UPDATE machine_manual_status SET signal_status = $2 WHERE machine_id = $1 AND ended_at IS NULL`, [event.machineId, event.status]);
  }
  return outcome;
}

/** The current status of a machine and since when (the latest machine_status event). */
export async function currentStatus(machineId: string): Promise<{ status: string; since: string } | null> {
  const result = await pool.query<{ status: string; since: Date }>(
    `SELECT payload->>'status' AS status, "timestamp" AS since FROM events
     WHERE machine_id = $1 AND type = 'machine_status'
     ORDER BY "timestamp" DESC LIMIT 1`,
    [machineId],
  );
  const row = result.rows[0];
  return row ? { status: row.status, since: new Date(row.since).toISOString() } : null;
}
