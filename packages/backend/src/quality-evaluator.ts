import type { FastifyBaseLogger } from "fastify";
import { raiseOrUpdateSystemAlert, resolveSystemAlert } from "./alerts-repository.js";
import { listOverdueChecks, raiseDueSpotChecks, type QualityCheck } from "./quality-repository.js";

/**
 * Every 30 s: opens the spot checks whose time is up (the part-count trigger runs on every part, this is also its
 * safety net), and keeps ONE system alert open while spot checks are overdue (older than the plan's grace time).
 * An overdue check does not stop the counting; a failed measurement does (quality-repository.ts).
 */

export const QUALITY_OVERDUE_ALERT_TYPE = "quality_check_overdue";
const CHECK_INTERVAL_MS = 30_000;
const MAX_LISTED = 5;

/** Pure: the alert text, oldest first. */
export function overdueMessage(checks: readonly Pick<QualityCheck, "orderNumber" | "machineName" | "machineId" | "createdAt">[], now = new Date()): string | null {
  if (checks.length === 0) return null;
  const listed = checks
    .slice(0, MAX_LISTED)
    .map((c) => `${c.orderNumber} on ${c.machineName ?? c.machineId ?? "?"} (due for ${Math.round((now.getTime() - new Date(c.createdAt).getTime()) / 60_000)} min)`)
    .join("; ");
  const more = checks.length > MAX_LISTED ? ` and ${checks.length - MAX_LISTED} more` : "";
  return `${checks.length === 1 ? "A spot check is" : `${checks.length} spot checks are`} overdue: ${listed}${more}. Measure at the terminal (Quality → Quality checks shows them).`;
}

export function startQualityEvaluator(log: FastifyBaseLogger): void {
  const run = async () => {
    const opened = await raiseDueSpotChecks();
    for (const o of opened) log.info(o, "spot check due");
    const message = overdueMessage(await listOverdueChecks());
    if (message) await raiseOrUpdateSystemAlert(QUALITY_OVERDUE_ALERT_TYPE, message);
    else await resolveSystemAlert(QUALITY_OVERDUE_ALERT_TYPE);
  };
  const tick = () => {
    run().catch((err) => log.error({ err }, "quality evaluator failed"));
  };
  tick();
  setInterval(tick, CHECK_INTERVAL_MS);
}
