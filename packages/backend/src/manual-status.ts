import { randomUUID } from "node:crypto";
import type { MachineEvent } from "@mes/shared";
import { pool } from "./db.js";
import { insertEvent } from "./events-repository.js";
import { publishToHub } from "./hub.js";
import { stateStore } from "./state.js";
import { rollupMachineStatus } from "./status-rollup-evaluator.js";

/**
 * Kézzel beállított gépállapot (terminál → "Státusz").
 *
 * Szabály: a kézi állapot addig érvényes, amíg
 *  - a gép újra termel: "running" jel vagy egy darab érkezik (egy
 *    elfelejtett "Beállítás" így nem maradhat bent gyártás közben) —
 *    KIVÉVE, ha az állapot blokkolja a gyártást (Status definitions →
 *    blocks_production): akkor a running jel csak jelként tárolódik, a
 *    darabok pedig production_count_blocked eseményként (nem számítanak),
 *  - a dolgozó le nem zárja (a gép jelére áll vissza),
 *  - a műszak véget nem ér (off-shift),
 *  - vagy egy másik kézi állapot le nem váltja.
 *
 * Kezdete: ha a gép a jele szerint áll (és nincs kézi állapota), a kézi
 * állapot a megállástól érvényes — a megállás és a kiválasztás közti idő így
 * nem marad "kezeletlen" leállás; ha már van kézi állapot, az új a
 * kiválasztástól számít (backdateFor).
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
  /** From when the status counts (the stop, when it was chosen for a stopped machine). */
  setAt: string;
  /** When it was chosen at the terminal. */
  selectedAt: string;
  signalStatus: string | null;
  /** From the status definition (the machine's own, else the global one), read live. */
  blocksProduction: boolean;
}

type Row = {
  id: string;
  machine_id: string;
  status_code: string;
  set_by_name: string | null;
  set_at: string | Date;
  selected_at: string | Date | null;
  signal_status: string | null;
  blocks_production: boolean | null;
};

function toManual(r: Row): ManualStatus {
  return {
    id: r.id,
    machineId: r.machine_id,
    statusCode: r.status_code,
    setByName: r.set_by_name,
    setAt: new Date(r.set_at).toISOString(),
    selectedAt: new Date(r.selected_at ?? r.set_at).toISOString(),
    signalStatus: r.signal_status,
    blocksProduction: r.blocks_production === true,
  };
}

export async function getActiveManualStatus(machineId: string): Promise<ManualStatus | undefined> {
  const result = await pool.query<Row>(
    `SELECT m.*,
            (SELECT d.blocks_production FROM machine_status_definitions d
             WHERE d.code = m.status_code AND (d.machine_id = m.machine_id OR d.machine_id IS NULL)
             ORDER BY d.machine_id NULLS LAST LIMIT 1) AS blocks_production
     FROM machine_manual_status m WHERE m.machine_id = $1 AND m.ended_at IS NULL`,
    [machineId],
  );
  return result.rows[0] ? toManual(result.rows[0]) : undefined;
}

export type SignalDecision =
  /** No manual status: the machine's signal is the status, as always. */
  | "apply"
  /** A buffered event from before the manual status: history, stored as it is, but not the live state. */
  | "history"
  /** The machine runs again: the manual status ends and the signal is the status. */
  | "apply_and_end"
  /** A part while a non-blocking manual status holds: it ends, the machine goes to running, the part counts. */
  | "count_and_run"
  /** A part while a blocking manual status holds: stored as production_count_blocked, not counted. */
  | "block"
  /** Kept as a signal only (machine_status_signal); the manual status stays. */
  | "suppress";

/** Pure: what a machine_status event from the machine means while a manual status may be active. */
export function decideSignal(
  manual: Pick<ManualStatus, "setAt" | "blocksProduction"> | undefined,
  event: { status: string; timestamp: string },
): SignalDecision {
  if (!manual) return "apply";
  if (new Date(event.timestamp).getTime() <= new Date(manual.setAt).getTime()) return "history";
  if (event.status === "running" && !manual.blocksProduction) return "apply_and_end";
  return "suppress";
}

/** Pure: what a production_count event means while a manual status may be active. */
export function decideCount(manual: Pick<ManualStatus, "setAt" | "blocksProduction"> | undefined, event: { timestamp: string }): SignalDecision {
  if (!manual) return "apply";
  // A buffered part from before the manual status was set: it was made then, it counts.
  if (new Date(event.timestamp).getTime() <= new Date(manual.setAt).getTime()) return "apply";
  return manual.blocksProduction ? "block" : "count_and_run";
}

async function emitStatus(machineId: string, status: string, extra: Record<string, unknown>, timestamp?: string): Promise<MachineEvent> {
  const event = {
    machineId,
    timestamp: timestamp ?? new Date().toISOString(),
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

/** Sources of a status event that stand for the machine's own signal (manual_end puts the signal back). */
const SIGNAL_SOURCES = ["machine", "manual_end"];
/** A status chosen for a stopped machine counts from the stop, but at most this far back. */
export const MAX_BACKDATE_HOURS = 24;

/**
 * Pure: from when a status chosen now counts. Given the machine's status events since its last "anchor" (running,
 * or set by someone — terminal, shift, a part) and its last counted part, the stop is the first event after the
 * anchor; with a part made after it, the moment after that part. Null: the status counts from now (the machine
 * runs, it is off shift, or nothing stopped it).
 */
export function backdateFor(input: {
  /** The machine's latest status event. */
  latest: { status: string; source: string; timestamp: string } | null;
  /** The first status event after the last anchor (the stop), if the latest is not an anchor. */
  stop: { timestamp: string } | null;
  /** The last counted part after the stop. */
  lastPart: string | null;
  now: Date;
}): string | null {
  const { latest, stop } = input;
  if (!latest || !stop) return null;
  if (!SIGNAL_SOURCES.includes(latest.source) || latest.status === "running" || latest.status === "off_shift") return null;
  let from = new Date(stop.timestamp).getTime();
  if (input.lastPart) from = Math.max(from, new Date(input.lastPart).getTime() + 1);
  from = Math.max(from, input.now.getTime() - MAX_BACKDATE_HOURS * 3600_000);
  return from < input.now.getTime() ? new Date(from).toISOString() : null;
}

/** The stop of a machine that stands without a manual status: from when a status chosen now counts (or null). */
async function stopStart(machineId: string, now: Date): Promise<string | null> {
  const latest = await pool.query<{ status: string; source: string; ts: Date }>(
    `SELECT payload->>'status' AS status, COALESCE(payload->>'source', 'machine') AS source, "timestamp" AS ts
     FROM events WHERE machine_id = $1 AND type = 'machine_status' ORDER BY "timestamp" DESC LIMIT 1`,
    [machineId],
  );
  const l = latest.rows[0];
  if (!l) return null;
  const stop = await pool.query<{ ts: Date }>(
    `SELECT min(e."timestamp") AS ts FROM events e
     WHERE e.machine_id = $1 AND e.type = 'machine_status'
       AND e."timestamp" > COALESCE((
         SELECT max(a."timestamp") FROM events a
         WHERE a.machine_id = $1 AND a.type = 'machine_status'
           AND (a.payload->>'status' = 'running' OR COALESCE(a.payload->>'source', 'machine') <> ALL($2::text[]))
       ), '-infinity'::timestamptz)`,
    [machineId, SIGNAL_SOURCES],
  );
  const stopTs = stop.rows[0]?.ts ?? null;
  const part = stopTs
    ? await pool.query<{ ts: Date | null }>(
        `SELECT max("timestamp") AS ts FROM events WHERE machine_id = $1 AND type = 'production_count' AND "timestamp" >= $2
           AND COALESCE(payload->>'reclassified', 'false') <> 'true'`,
        [machineId, stopTs],
      )
    : undefined;
  return backdateFor({
    latest: { status: l.status, source: l.source, timestamp: new Date(l.ts).toISOString() },
    stop: stopTs ? { timestamp: new Date(stopTs).toISOString() } : null,
    lastPart: part?.rows[0]?.ts ? new Date(part.rows[0].ts).toISOString() : null,
    now,
  });
}

/**
 * Sets a manual status (ending an earlier one as "replaced"). Writes the
 * machine_status event, so the live view and every report see it at once.
 *
 * For a stopped machine without a manual status it counts from the stop: the machine's status events since then
 * become signals (machine_status_signal) and the hourly status rollup is recomputed from there. Replacing a manual
 * status counts from now.
 */
export async function setManualStatus(input: { machineId: string; statusCode: string; userId: string; userName: string; terminalId: string }): Promise<ManualStatus> {
  const previous = await getActiveManualStatus(input.machineId);
  const signal = previous ? previous.signalStatus : await lastSignalStatus(input.machineId);
  const now = new Date();
  const from = previous ? null : await stopStart(input.machineId, now);
  const client = await pool.connect();
  let created: ManualStatus;
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE machine_manual_status SET ended_at = now(), end_reason = 'replaced', ended_by = $2 WHERE machine_id = $1 AND ended_at IS NULL`, [
      input.machineId,
      input.userId,
    ]);
    const id = randomUUID();
    const result = await client.query<Row>(
      `INSERT INTO machine_manual_status (id, machine_id, status_code, set_by, set_by_name, terminal_id, signal_status, set_at, selected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, $9::timestamptz), $9::timestamptz) RETURNING *`,
      [id, input.machineId, input.statusCode, input.userId, input.userName, input.terminalId, signal, from, now.toISOString()],
    );
    if (from) {
      // The machine's own status events since the stop are covered by this status now: kept as signals.
      await client.query(
        `UPDATE events SET type = 'machine_status_signal', payload = payload || jsonb_build_object('type', 'machine_status_signal', 'coveredByManualStatus', $3::text)
         WHERE machine_id = $1 AND type = 'machine_status' AND "timestamp" >= $2 AND COALESCE(payload->>'source', 'machine') = ANY($4::text[])`,
        [input.machineId, from, id, SIGNAL_SOURCES],
      );
      // A "down" period already closed inside that time (down, then idle) is no longer a stop of its own.
      await client.query(`DELETE FROM downtime_periods WHERE machine_id = $1 AND started_at >= $2 AND fault_report_id IS NULL`, [input.machineId, from]);
    }
    await client.query("COMMIT");
    created = toManual(result.rows[0]!);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await emitStatus(input.machineId, input.statusCode, { source: "terminal", setBy: input.userName, ...(from ? { selectedAt: now.toISOString() } : {}) }, from ?? now.toISOString());
  if (from) {
    // The past hours changed: recompute them now rather than at the next rollup tick.
    const hour = new Date(from);
    hour.setMinutes(0, 0, 0);
    await rollupMachineStatus(hour).catch(() => undefined);
  }
  return created;
}

/**
 * Ends the active manual status. For the operator and the end of a shift the
 * machine goes back to what its signal last said (a machine_status event);
 * for "signal_running" the incoming running event is that status already;
 * for "production" (a part arrived) the machine goes to running at the part's time.
 */
export async function endManualStatus(
  machineId: string,
  reason: "operator" | "signal_running" | "production" | "off_shift",
  userId: string | null = null,
  at?: string,
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
  if (ended && reason === "production") {
    // Not earlier than the manual status itself, so the timeline stays in order.
    const ts = at && new Date(at).getTime() > new Date(ended.setAt).getTime() ? at : new Date().toISOString();
    await emitStatus(machineId, "running", { source: "production" }, ts);
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

/**
 * A part made while production is blocked — by a blocking manual status or by a quality check (first piece not
 * passed yet, or a failed measurement): kept as data, never counted.
 */
export async function recordBlockedCount(
  event: MachineEvent & { type: "production_count" },
  blockedBy: "manual_status" | "quality" = "manual_status",
  extra: Record<string, unknown> = {},
): Promise<"inserted" | "duplicate"> {
  return insertEvent({ ...event, type: "production_count_blocked", blockedBy, ...extra } as unknown as MachineEvent);
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
