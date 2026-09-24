import type { FastifyBaseLogger } from "fastify";
import { checkAndAutoCompleteWorkOrders } from "./work-order-completion-service.js";

const EVAL_INTERVAL_MS = 60_000;

export function startWorkOrderAutoCompleteEvaluator(log: FastifyBaseLogger): void {
  const run = async () => {
    try {
      await checkAndAutoCompleteWorkOrders();
    } catch (err) {
      log.error({ err }, "work-order auto-complete evaluator tick failed");
    }
  };
  setInterval(() => void run(), EVAL_INTERVAL_MS);
  void run();
}