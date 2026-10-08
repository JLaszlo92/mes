/**
 * Pure decision logic for the "edge node offline" alert (no I/O, no db import, so
 * it can be unit-tested without DATABASE_URL). Used by edge-offline-health-evaluator.ts.
 *
 * An edge node that stops reporting keeps buffering the events of its machines on
 * its own disk, but nothing reaches the server: the dashboard goes stale without any
 * error. The Edge nodes page already shows an "offline" label after 90 s
 * (HEARTBEAT_STALE_SECONDS), but nothing raised an alert (chaos slice 12, finding 20).
 * This alert is deliberately slower than that label (default 3 minutes) so a restart
 * or an agent deploy does not flap it.
 *
 * The last sign of life is the last heartbeat; a node that was stopped cleanly has no
 * heartbeat (the lease is released) and is measured from its last_seen_at instead, so
 * a node that was stopped and forgotten is reported too. A node that never reported
 * is not reported.
 */

export const EDGE_OFFLINE_ALERT_TYPE = "edge_node_offline";
export const DEFAULT_EDGE_OFFLINE_SECONDS = 180;
const MIN_EDGE_OFFLINE_SECONDS = 120;
const MAX_EDGE_OFFLINE_SECONDS = 86_400;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const MAX_LISTED = 5;

/** EDGE_OFFLINE_ALERT_SECONDS (120 to 86400); anything else gives the default. */
export function offlineSecondsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.EDGE_OFFLINE_ALERT_SECONDS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_EDGE_OFFLINE_SECONDS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= MIN_EDGE_OFFLINE_SECONDS && n <= MAX_EDGE_OFFLINE_SECONDS ? n : DEFAULT_EDGE_OFFLINE_SECONDS;
}

/** "4 min", "3 h", "2 days". */
export function describeSilence(ms: number): string {
  if (ms < 120 * MINUTE_MS) return `${Math.floor(ms / MINUTE_MS)} min`;
  const hours = Math.floor(ms / HOUR_MS);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

export interface EdgeSeenRow {
  name: string;
  /** Last heartbeat; null after a clean stop or when the node never reported. */
  lastHeartbeatMs: number | null;
  /** Last sign of life, also set by a clean stop; null when the node never reported. */
  lastSeenMs: number | null;
}

export type EdgeOfflineHealth = { healthy: true } | { healthy: false; message: string };

export function assessEdgeOffline(rows: readonly EdgeSeenRow[], nowMs: number, thresholdSec: number = DEFAULT_EDGE_OFFLINE_SECONDS): EdgeOfflineHealth {
  const limitMs = thresholdSec * 1000;
  const due: { name: string; silentMs: number; stopped: boolean }[] = [];
  for (const r of rows) {
    const stopped = r.lastHeartbeatMs === null;
    const reference = stopped ? r.lastSeenMs : r.lastHeartbeatMs;
    if (reference === null) continue; // never reported
    const silentMs = nowMs - reference;
    if (silentMs > limitMs) due.push({ name: r.name, silentMs, stopped });
  }
  if (due.length === 0) return { healthy: true };

  due.sort((a, b) => b.silentMs - a.silentMs);
  const listed = due
    .slice(0, MAX_LISTED)
    .map((d) => `${d.name} (${d.stopped ? `stopped ${describeSilence(d.silentMs)} ago` : `no heartbeat for ${describeSilence(d.silentMs)}`})`)
    .join(", ");
  const more = due.length > MAX_LISTED ? ` and ${due.length - MAX_LISTED} more` : "";
  const noun = due.length === 1 ? "edge node has" : "edge nodes have";
  return {
    healthy: false,
    message:
      `${due.length} ${noun} not reported for more than ${describeSilence(limitMs)}: ${listed}${more}. ` +
      `The machines behind it send nothing to the server; the device keeps their events in its disk buffer and delivers them when it is back ` +
      `(check its power and network and the mes-edge-node service).`,
  };
}
