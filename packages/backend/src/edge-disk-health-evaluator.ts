import type { FastifyBaseLogger } from "fastify";
import { pool } from "./db.js";
import { raiseOrUpdateSystemAlert, resolveSystemAlert } from "./alerts-repository.js";
import { createCriticalCheck, criticalLimitsFromEnv, limitsFromEnv } from "./disk-health-evaluator.js";
import { assessDisks, type DiskLimits, type DiskVolume } from "./disk-health.js";
import { ONLINE_WITHIN_SECONDS } from "./edge-clock-health-evaluator.js";

/**
 * Raises one system alert while the disk of an online edge node is nearly full
 * (same limits as the backend host, see disk-health-evaluator.ts) and resolves
 * it when there is room again. The figures come from the agent's claim and
 * heartbeat (v9 and later); an offline node and an older agent are ignored.
 * The disk holds the event buffer, which grows while the server is unreachable.
 */

export const EDGE_DISK_ALERT_TYPE = "edge_disk_space";
export const EDGE_DISK_CRITICAL_ALERT_TYPE = "edge_disk_space_critical";
const CHECK_INTERVAL_MS = 60 * 1000;
const CRITICAL_CONSEQUENCE = "The edge agent is about to stop buffering events while the server is unreachable — free up space on the device NOW.";
const CONSEQUENCE = "A full disk stops the edge agent from buffering events while the server is unreachable — free up space on the device.";

interface Row {
  name: string;
  disk_used_bytes: string | number | null;
  disk_avail_bytes: string | number | null;
}

export function createEdgeDiskCheck(log: FastifyBaseLogger, limits: DiskLimits, critical?: DiskLimits): () => Promise<void> {
  let alerting = false;
  const criticalCheck = critical ? createCriticalCheck(log, EDGE_DISK_CRITICAL_ALERT_TYPE, critical, CRITICAL_CONSEQUENCE) : null;
  return async () => {
    const result = await pool.query<Row>(
      `SELECT name, disk_used_bytes, disk_avail_bytes
         FROM edge_nodes
        WHERE last_heartbeat_at IS NOT NULL
          AND last_heartbeat_at > now() - make_interval(secs => $1::double precision)
          AND disk_used_bytes IS NOT NULL AND disk_avail_bytes IS NOT NULL
        ORDER BY name`,
      [ONLINE_WITHIN_SECONDS],
    );
    const volumes: DiskVolume[] = result.rows.map((r) => ({
      label: `edge node ${r.name}`,
      usedBytes: Number(r.disk_used_bytes),
      availBytes: Number(r.disk_avail_bytes),
    }));
    await criticalCheck?.(volumes);
    const health = assessDisks(volumes, alerting, limits, CONSEQUENCE);
    if (health.healthy) {
      if (await resolveSystemAlert(EDGE_DISK_ALERT_TYPE)) log.info("edge node disks are back within the limit — alert resolved");
      alerting = false;
      return;
    }
    alerting = true;
    if (await raiseOrUpdateSystemAlert(EDGE_DISK_ALERT_TYPE, health.message)) {
      log.warn({ reason: health.message }, "edge node disk space alert raised");
    }
  };
}

export function startEdgeDiskEvaluator(log: FastifyBaseLogger): void {
  const check = createEdgeDiskCheck(log, limitsFromEnv(), criticalLimitsFromEnv());
  const run = () => {
    check().catch((err) => log.error({ err }, "edge node disk check failed"));
  };
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}
