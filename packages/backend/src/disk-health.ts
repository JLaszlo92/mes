/**
 * Pure decision logic for the disk space alert (no I/O, unit-testable).
 * Used by disk-health-evaluator.ts.
 *
 * A full disk stops Postgres from writing events (and, if the WAL disk fills
 * up, stops the database altogether), so the alert comes well before that: at
 * 85 % used or less than 2 GiB available. Once raised it clears at 80 % (and
 * 25 % more free space than the minimum), so a value hovering at the limit does
 * not raise and resolve the alert over and over.
 */

export const DISK_ALERT_TYPE = "disk_space";
const GIB = 1024 ** 3;

export interface DiskVolume {
  /** The path that was checked, e.g. "/". */
  label: string;
  usedBytes: number;
  /** Space available to a normal process (what df calls "Avail"). */
  availBytes: number;
}

export interface DiskLimits {
  raisePercent: number;
  clearPercent: number;
  minFreeBytes: number;
}

export const DEFAULT_DISK_LIMITS: DiskLimits = { raisePercent: 85, clearPercent: 80, minFreeBytes: 2 * GIB };

export type DiskHealth = { healthy: true } | { healthy: false; message: string };

/** Used share like df's "Use%": used / (used + available). */
export function usedPercent(v: DiskVolume): number {
  const total = v.usedBytes + v.availBytes;
  return total > 0 ? (v.usedBytes / total) * 100 : 0;
}

function formatGiB(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

export const DB_DISK_CONSEQUENCE = "A full disk stops the database from writing events — free up space or enlarge the volume.";

export function assessDisks(
  volumes: readonly DiskVolume[],
  wasAlerting: boolean,
  limits: DiskLimits = DEFAULT_DISK_LIMITS,
  consequence: string = DB_DISK_CONSEQUENCE,
): DiskHealth {
  const percentLimit = wasAlerting ? limits.clearPercent : limits.raisePercent;
  const freeLimit = wasAlerting ? limits.minFreeBytes * 1.25 : limits.minFreeBytes;

  const problems = volumes
    .filter((v) => v.usedBytes + v.availBytes > 0)
    .filter((v) => usedPercent(v) >= percentLimit || v.availBytes < freeLimit)
    .sort((a, b) => usedPercent(b) - usedPercent(a));
  if (problems.length === 0) return { healthy: true };

  const listed = problems
    .map((v) => `${v.label} is ${Math.round(usedPercent(v))}% used (${formatGiB(v.availBytes)} free of ${formatGiB(v.usedBytes + v.availBytes)})`)
    .join("; ");
  return {
    healthy: false,
    message: `Disk space is running low: ${listed}. ${consequence}`,
  };
}
