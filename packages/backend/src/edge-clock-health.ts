/**
 * Pure decision logic for the edge clock alert (no I/O, no db import, so it can
 * be unit-tested without DATABASE_URL). Used by edge-clock-health-evaluator.ts.
 *
 * Event timestamps come from the device's clock. A device whose clock differs
 * from the server's by more than CLOCK_WARN_MS puts events in the future or the
 * past and can hide real status changes, so it raises one system alert that
 * lists the nodes. A node that is offline is ignored: its last offset is old
 * news, and it is measured again when the agent claims the node.
 */
import { CLOCK_WARN_MS, isClockSkewed } from "./clock-offset.js";

export const EDGE_CLOCK_ALERT_TYPE = "edge_clock_skew";

export interface EdgeClockRow {
  name: string;
  /** The agent's heartbeat is fresh. */
  online: boolean;
  /** Device clock minus server clock in ms; null = unknown (agent older than v7). */
  clockOffsetMs: number | null;
}

export type EdgeClockHealth = { healthy: true } | { healthy: false; message: string };

const MAX_LISTED = 5;

/** "in sync", "45 s ahead", "15 min behind", "3 h ahead", "20000 days behind". */
export function describeClockOffset(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 2000) return "in sync";
  const direction = ms > 0 ? "ahead" : "behind";
  if (abs < 120_000) return `${Math.round(abs / 1000)} s ${direction}`;
  if (abs < 7_200_000) return `${Math.round(abs / 60_000)} min ${direction}`;
  if (abs < 172_800_000) return `${Math.round(abs / 3_600_000)} h ${direction}`;
  return `${Math.round(abs / 86_400_000)} days ${direction}`;
}

export function assessEdgeClocks(rows: readonly EdgeClockRow[], limitMs: number = CLOCK_WARN_MS): EdgeClockHealth {
  const skewed = rows
    .filter((r) => r.online && r.clockOffsetMs !== null && isClockSkewed(r.clockOffsetMs, limitMs))
    .sort((a, b) => Math.abs(b.clockOffsetMs as number) - Math.abs(a.clockOffsetMs as number));
  if (skewed.length === 0) return { healthy: true };

  const listed = skewed
    .slice(0, MAX_LISTED)
    .map((r) => `${r.name} (${describeClockOffset(r.clockOffsetMs as number)})`)
    .join(", ");
  const more = skewed.length > MAX_LISTED ? ` and ${skewed.length - MAX_LISTED} more` : "";
  const noun = skewed.length === 1 ? "edge node" : "edge nodes";
  return {
    healthy: false,
    message:
      `The clock of ${skewed.length} ${noun} differs from the server's by more than ${Math.round(limitMs / 1000)} s: ${listed}${more}. ` +
      `Event timestamps from these devices are wrong and can hide real status changes — check the time synchronisation (NTP) on the device.`,
  };
}
