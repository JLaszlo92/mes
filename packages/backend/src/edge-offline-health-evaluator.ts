import type { FastifyBaseLogger } from "fastify";
import { pool } from "./db.js";
import { raiseOrUpdateSystemAlert, resolveSystemAlert } from "./alerts-repository.js";
import { EDGE_OFFLINE_ALERT_TYPE, assessEdgeOffline, offlineSecondsFromEnv, type EdgeSeenRow } from "./edge-offline-health.js";

/**
 * Raises one system alert while an edge node that has reported before has been silent
 * for longer than the limit (default 3 minutes, EDGE_OFFLINE_ALERT_SECONDS) and resolves
 * it once every node is back. After a restart of the backend itself the evaluator waits
 * for as long as the limit before it looks: the nodes' last heartbeats are old then,
 * only because the backend was not there to receive them.
 */

const CHECK_INTERVAL_MS = 60 * 1000;

interface Row {
  name: string;
  last_heartbeat_at: Date | string | null;
  last_seen_at: Date | string | null;
}

const toMs = (v: Date | string | null): number | null => (v === null ? null : new Date(v).getTime());

export function createEdgeOfflineCheck(
  log: FastifyBaseLogger,
  thresholdSec: number = offlineSecondsFromEnv(),
  now: () => number = Date.now,
  uptimeSec: () => number = () => process.uptime(),
): () => Promise<void> {
  return async () => {
    if (uptimeSec() < thresholdSec) return;
    const result = await pool.query<Row>(
      `SELECT name, last_heartbeat_at, last_seen_at
         FROM edge_nodes
        WHERE last_heartbeat_at IS NOT NULL OR last_seen_at IS NOT NULL
        ORDER BY name`,
    );
    const rows: EdgeSeenRow[] = result.rows.map((r) => ({
      name: r.name,
      lastHeartbeatMs: toMs(r.last_heartbeat_at),
      lastSeenMs: toMs(r.last_seen_at),
    }));
    const health = assessEdgeOffline(rows, now(), thresholdSec);

    if (health.healthy) {
      if (await resolveSystemAlert(EDGE_OFFLINE_ALERT_TYPE)) log.info("all edge nodes are reporting again — alert resolved");
      return;
    }
    if (await raiseOrUpdateSystemAlert(EDGE_OFFLINE_ALERT_TYPE, health.message)) {
      log.warn({ reason: health.message }, "edge node offline alert raised");
    }
  };
}

export function startEdgeOfflineEvaluator(log: FastifyBaseLogger): void {
  const check = createEdgeOfflineCheck(log);
  const run = () => {
    check().catch((err) => log.error({ err }, "edge node offline check failed"));
  };
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}
