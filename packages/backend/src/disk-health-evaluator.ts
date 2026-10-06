import { stat, statfs } from "node:fs/promises";
import type { FastifyBaseLogger } from "fastify";
import { raiseOrUpdateSystemAlert, resolveSystemAlert } from "./alerts-repository.js";
import { DEFAULT_DISK_LIMITS, DISK_ALERT_TYPE, assessDisks, type DiskLimits, type DiskVolume } from "./disk-health.js";

/**
 * Raises one system alert while a disk of this host (node-dc: the root file
 * system and the one holding the Postgres data, usually the same) is nearly
 * full, and resolves it when there is room again.
 *
 * Settings (environment of the backend service, all optional):
 *   DISK_CHECK_PATHS     comma separated, default "/,/var/lib/postgresql"
 *   DISK_WARN_PERCENT    default 85 (clears at 5 points below)
 *   DISK_MIN_FREE_GIB    default 2
 */

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_PATHS = ["/", "/var/lib/postgresql"];

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function limitsFromEnv(): DiskLimits {
  const raisePercent = numberFromEnv("DISK_WARN_PERCENT", DEFAULT_DISK_LIMITS.raisePercent);
  return {
    raisePercent,
    clearPercent: Math.max(raisePercent - 5, 1),
    minFreeBytes: numberFromEnv("DISK_MIN_FREE_GIB", DEFAULT_DISK_LIMITS.minFreeBytes / 1024 ** 3) * 1024 ** 3,
  };
}

export function pathsFromEnv(): string[] {
  const raw = process.env.DISK_CHECK_PATHS;
  const paths = raw ? raw.split(",").map((p) => p.trim()).filter(Boolean) : DEFAULT_PATHS;
  return paths.length > 0 ? paths : DEFAULT_PATHS;
}

/** One entry per file system: two paths on the same device are checked once. A missing path is skipped. */
export async function readVolumes(paths: readonly string[]): Promise<DiskVolume[]> {
  const seen = new Set<number>();
  const volumes: DiskVolume[] = [];
  for (const path of paths) {
    try {
      const { dev } = await stat(path);
      if (seen.has(dev)) continue;
      seen.add(dev);
      const fs = await statfs(path);
      volumes.push({ label: path, usedBytes: (fs.blocks - fs.bfree) * fs.bsize, availBytes: fs.bavail * fs.bsize });
    } catch {
      // The path does not exist on this host (e.g. no local Postgres): nothing to check.
    }
  }
  return volumes;
}

/** Returns the check; it remembers whether the alert is raised (for the hysteresis). */
export function createDiskCheck(log: FastifyBaseLogger, paths: readonly string[], limits: DiskLimits): () => Promise<void> {
  let alerting = false;
  return async () => {
    const health = assessDisks(await readVolumes(paths), alerting, limits);
    if (health.healthy) {
      if (await resolveSystemAlert(DISK_ALERT_TYPE)) log.info("disk space is back within the limit — alert resolved");
      alerting = false;
      return;
    }
    alerting = true;
    if (await raiseOrUpdateSystemAlert(DISK_ALERT_TYPE, health.message)) {
      log.warn({ reason: health.message }, "disk space alert raised");
    }
  };
}

export function startDiskSpaceEvaluator(log: FastifyBaseLogger): void {
  const check = createDiskCheck(log, pathsFromEnv(), limitsFromEnv());
  const run = () => {
    check().catch((err) => log.error({ err }, "disk space check failed"));
  };
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}
