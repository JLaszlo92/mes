import type { FastifyBaseLogger } from "fastify";
import { pool } from "./db.js";
import { stateStore } from "./state.js";
import { listAlertRules, type AlertRule } from "./alert-rules-repository.js";
import { findOpenAlert, raiseAlert, resolveOpenAlert } from "./alerts-repository.js";

const EVAL_INTERVAL_MS = 30_000;

async function evaluateMachineDownRule(rule: AlertRule, log: FastifyBaseLogger): Promise<void> {
  const machines = rule.machineId
    ? (() => {
        const m = stateStore.get(rule.machineId!);
        return m ? [m] : [];
      })()
    : stateStore.getAll();

  for (const state of machines) {
    const downSinceMs = Date.now() - new Date(state.lastUpdated).getTime();
    const isDownLongEnough = state.status === "down" && downSinceMs >= rule.threshold * 60_000;

    const open = await findOpenAlert(rule.id, state.machineId);
    if (isDownLongEnough && !open) {
      await raiseAlert(
        rule.id,
        state.machineId,
        "machine_down",
        `${state.machineId} has been down for over ${rule.threshold} minute(s)`,
      );
      log.warn({ machineId: state.machineId, ruleId: rule.id }, "alert raised: machine_down");
    } else if (!isDownLongEnough && open) {
      await resolveOpenAlert(rule.id, state.machineId);
    }
  }
}

async function evaluateScrapRateRule(rule: AlertRule, log: FastifyBaseLogger): Promise<void> {
  const machineFilter = rule.machineId ? `AND machine_id = $2` : "";
  const params = rule.machineId ? [rule.machineId] : [];

  const result = await pool.query<{ machine_id: string; good_count: string; scrap_count: string }>(
    `SELECT
       machine_id,
       COUNT(*) FILTER (WHERE payload->>'result' = 'good') AS good_count,
       COUNT(*) FILTER (WHERE payload->>'result' = 'scrap') AS scrap_count
     FROM events
     WHERE type = 'production_count'
       AND "timestamp" > now() - INTERVAL '30 minutes'
       ${machineFilter}
     GROUP BY machine_id`,
    params,
  );

  for (const row of result.rows) {
    const good = Number(row.good_count);
    const scrap = Number(row.scrap_count);
    const total = good + scrap;
    const scrapRatePct = total > 0 ? (scrap / total) * 100 : 0;
    // Legalább 5 darab, mielőtt véleményt mondunk — enélkül egy frissen
    // indult gép első selejt darabja azonnal 100%-os rátával riasztana.
    const isAboveThreshold = total >= 5 && scrapRatePct >= rule.threshold;

    const open = await findOpenAlert(rule.id, row.machine_id);
    if (isAboveThreshold && !open) {
      await raiseAlert(
        rule.id,
        row.machine_id,
        "scrap_rate",
        `${row.machine_id} scrap rate is ${scrapRatePct.toFixed(1)}% over the last 30 minutes`,
      );
      log.warn({ machineId: row.machine_id, ruleId: rule.id, scrapRatePct }, "alert raised: scrap_rate");
    } else if (!isAboveThreshold && open) {
      await resolveOpenAlert(rule.id, row.machine_id);
    }
  }
}

export function startAlertEvaluator(log: FastifyBaseLogger): void {
  const tick = async () => {
    try {
      const rules = (await listAlertRules()).filter((r) => r.isActive);
      for (const rule of rules) {
        if (rule.type === "machine_down") await evaluateMachineDownRule(rule, log);
        else if (rule.type === "scrap_rate") await evaluateScrapRateRule(rule, log);
      }
    } catch (err) {
      log.error({ err }, "alert evaluation tick failed");
    }
  };

  setInterval(() => void tick(), EVAL_INTERVAL_MS);
  void tick(); // első futás azonnal, ne kelljen 30 másodpercet várni induláskor
}