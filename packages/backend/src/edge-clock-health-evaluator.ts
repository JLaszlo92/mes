import type { FastifyBaseLogger } from "fastify";
import { pool } from "./db.js";
import { raiseOrUpdateSystemAlert, resolveSystemAlert } from "./alerts-repository.js";
import { parseStoredOffset } from "./clock-offset.js";
import { EDGE_CLOCK_ALERT_TYPE, assessEdgeClocks, type EdgeClockRow } from "./edge-clock-health.js";

/**
 * Raises one system alert while an online edge node's clock differs from the
 * server's by more than the warning limit, and resolves it when every online
 * node is back within it. The offset is measured by the agent's claim and
 * heartbeat (edge-nodes-repository.ts), see clock-offset.ts.
 */

const CHECK_INTERVAL_MS = 60 * 1000;
/** Same freshness as the online state on the Edge nodes page (HEARTBEAT_STALE_SECONDS). */
export const ONLINE_WITHIN_SECONDS = 90;

export async function checkEdgeClocks(log: FastifyBaseLogger): Promise<void> {
  const result = await pool.query<{ name: string; online: boolean; clock_offset_ms: string | number | null }>(
    `SELECT name,
            (last_heartbeat_at IS NOT NULL AND last_heartbeat_at > now() - make_interval(secs => $1::double precision)) AS online,
            clock_offset_ms
       FROM edge_nodes
      ORDER BY name`,
    [ONLINE_WITHIN_SECONDS],
  );
  const rows: EdgeClockRow[] = result.rows.map((r) => ({
    name: r.name,
    online: r.online,
    clockOffsetMs: parseStoredOffset(r.clock_offset_ms),
  }));
  const health = assessEdgeClocks(rows);

  if (health.healthy) {
    if (await resolveSystemAlert(EDGE_CLOCK_ALERT_TYPE)) log.info("edge node clocks are back within the limit — alert resolved");
    return;
  }
  if (await raiseOrUpdateSystemAlert(EDGE_CLOCK_ALERT_TYPE, health.message)) {
    log.warn({ reason: health.message }, "edge node clock skew alert raised");
  }
}

export function startEdgeClockEvaluator(log: FastifyBaseLogger): void {
  const run = () => {
    checkEdgeClocks(log).catch((err) => log.error({ err }, "edge node clock check failed"));
  };
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}
