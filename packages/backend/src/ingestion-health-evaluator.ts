import type { FastifyBaseLogger } from "fastify";
import { raiseOrUpdateSystemAlert, resolveSystemAlert } from "./alerts-repository.js";
import { INGESTION_ALERT_TYPE, ingestionHealth, type IngestionTracker } from "./ingestion-health.js";

/**
 * Raises one system alert "ingestion_failing" while the events cannot be stored (see ingestion-health.ts) and resolves
 * it after the first stored event. The alert is written to the database that may be unable to write: a failed write is
 * logged and tried again at the next check; GET /health?db=1 reports the state without the database.
 */

const CHECK_INTERVAL_MS = 15_000;

export interface IngestionCheckDeps {
  raise: (type: string, message: string) => Promise<boolean>;
  resolve: (type: string) => Promise<boolean>;
}

/** Returns the check. It remembers whether a resolve is still due (after a start an alert of the previous run may be open). */
export function createIngestionCheck(
  log: FastifyBaseLogger,
  tracker: IngestionTracker = ingestionHealth,
  deps: IngestionCheckDeps = { raise: raiseOrUpdateSystemAlert, resolve: resolveSystemAlert },
): () => Promise<void> {
  let resolveDue = true;
  return async () => {
    const status = tracker.status();
    if (!status.failing) {
      if (!resolveDue) return;
      if (await deps.resolve(INGESTION_ALERT_TYPE)) log.info("events can be stored again - ingestion alert resolved");
      resolveDue = false;
      return;
    }
    resolveDue = true;
    try {
      if (await deps.raise(INGESTION_ALERT_TYPE, status.message)) log.warn({ reason: status.message }, "ingestion alert raised");
    } catch (err) {
      log.warn({ err }, "could not record the ingestion alert (the database cannot write?) - will try again");
    }
  };
}

export function startIngestionEvaluator(log: FastifyBaseLogger): void {
  const check = createIngestionCheck(log);
  const run = () => {
    check().catch((err) => log.error({ err }, "ingestion check failed"));
  };
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}
