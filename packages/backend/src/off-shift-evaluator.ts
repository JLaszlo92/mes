import type { FastifyBaseLogger } from "fastify";
import { randomUUID } from "node:crypto";
import type { MachineEvent } from "@mes/shared";
import { pool } from "./db.js";
import { insertEvent } from "./events-repository.js";
import { stateStore } from "./state.js";
import { publishToHub } from "./hub.js";

const EVAL_INTERVAL_MS = 60_000;

/**
 * Azoknál a gépeknél, ahol az auto_offshift_status be van kapcsolva,
 * ellenőrzi, hogy a jelenlegi pillanat a naptár/műszakrend szerint
 * "műszakon kívülre" esik-e (resolve_shift() "off_shift"-et ad vissza),
 * és ha igen — és a gép jelenlegi ismert állapota még nem az —, egy
 * szintetikus machine_status: off_shift eseményt rögzít.
 */
async function tick(): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM machines WHERE is_active AND auto_offshift_status = true`,
  );

  for (const row of result.rows) {
    const machineId = row.id;

    const shiftResult = await pool.query<{ shift_name: string }>(
      `SELECT shift_name FROM resolve_shift($1, now())`,
      [machineId],
    );
    const shiftName = shiftResult.rows[0]?.shift_name;
    if (shiftName !== "off_shift") continue;

    const currentState = stateStore.get(machineId);
    if (currentState?.status === "off_shift") continue;

    const event: MachineEvent = {
      machineId,
      timestamp: new Date().toISOString(),
      sourceEventId: randomUUID(),
      type: "machine_status",
      status: "off_shift",
    };

    await insertEvent(event);
    stateStore.applyEvent(event);
    publishToHub(event);
  }
}

export function startOffShiftEvaluator(log: FastifyBaseLogger): void {
  const run = async () => {
    try {
      await tick();
    } catch (err) {
      log.error({ err }, "off-shift evaluator tick failed");
    }
  };
  setInterval(() => void run(), EVAL_INTERVAL_MS);
  void run();
}