import { readFile } from "node:fs/promises";
import type { FastifyBaseLogger } from "fastify";
import { pool } from "./db.js";
import { raiseOrUpdateSystemAlert, resolveSystemAlert } from "./alerts-repository.js";
import { deviceCaFingerprint, verifyLicense, type LicenseStatus } from "./license.js";
import { licenseConfigFromEnv, licenseWarning } from "./license-policy.js";

/**
 * Loads and verifies the license file, keeps the latest result in memory and
 * raises/resolves a system alert. The file is re-read hourly (and on demand),
 * so a renewal is a file replacement — no restart. See docs/LICENSING.md.
 */

export const LICENSE_ALERT_TYPE = "license_health";
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export const licenseConfig = licenseConfigFromEnv();

export interface LicenseSnapshot {
  /** false until the first check finished; the guard never blocks before that. */
  checked: boolean;
  status: LicenseStatus;
  fileFound: boolean;
  enforce: boolean;
  checkedAt: Date | null;
  edgeNodes: number;
}

let snapshot: LicenseSnapshot = {
  checked: false,
  status: { state: "invalid", reason: "license not checked yet", payload: null, daysLeft: null },
  fileFound: false,
  enforce: licenseConfig.enforce,
  checkedAt: null,
  edgeNodes: 0,
};

export function getLicenseSnapshot(): LicenseSnapshot {
  return snapshot;
}

export async function countEdgeNodes(): Promise<number> {
  const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM edge_nodes`);
  return r.rows[0]?.n ?? 0;
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

const invalid = (reason: string): LicenseStatus => ({ state: "invalid", reason, payload: null, daysLeft: null });

async function evaluateFiles(now: Date, minSerial: number): Promise<{ status: LicenseStatus; fileFound: boolean }> {
  const text = await readOrNull(licenseConfig.file);
  if (text === null) return { status: invalid(`no license file at ${licenseConfig.file}`), fileFound: false };
  const pub = await readOrNull(licenseConfig.publicKeyFile);
  if (pub === null) return { status: invalid(`license public key missing at ${licenseConfig.publicKeyFile}`), fileFound: true };
  const ca = await readOrNull(licenseConfig.deviceCaFile);
  if (ca === null) return { status: invalid(`device CA certificate missing at ${licenseConfig.deviceCaFile}`), fileFound: true };
  let fingerprint: string;
  try {
    fingerprint = deviceCaFingerprint(ca);
  } catch {
    return { status: invalid("device CA certificate is unreadable"), fileFound: true };
  }
  return {
    status: verifyLicense(text, { publicKeyPem: pub, deviceCaSha256: fingerprint, now, minSerial }),
    fileFound: true,
  };
}

export async function refreshLicense(log: FastifyBaseLogger, now: Date = new Date()): Promise<LicenseSnapshot> {
  const stateRow = await pool.query<{ max_serial: number; last_seen_at: Date }>(
    `SELECT max_serial, last_seen_at FROM license_state WHERE id`,
  );
  const maxSerial = stateRow.rows[0]?.max_serial ?? 0;
  const lastSeen = stateRow.rows[0]?.last_seen_at ?? new Date(0);
  // Setting the clock back must not extend a license.
  const effectiveNow = new Date(Math.max(now.getTime(), lastSeen.getTime()));

  const { status, fileFound } = await evaluateFiles(effectiveNow, maxSerial);

  const usable = status.state === "valid" || status.state === "grace";
  await pool.query(
    `UPDATE license_state
        SET last_seen_at = GREATEST(last_seen_at, $1),
            max_serial   = GREATEST(max_serial, $2),
            license_id   = COALESCE($3, license_id),
            updated_at   = now()
      WHERE id`,
    [effectiveNow, usable ? status.payload?.serial ?? 0 : 0, usable ? status.payload?.licenseId ?? null : null],
  );

  const edgeNodes = await countEdgeNodes();
  const previous = snapshot;
  snapshot = { checked: true, status, fileFound, enforce: licenseConfig.enforce, checkedAt: now, edgeNodes };

  if (!previous.checked || previous.status.state !== status.state || previous.status.reason !== status.reason) {
    log.info(
      { license: status.state, reason: status.reason, daysLeft: status.daysLeft, enforce: licenseConfig.enforce, edgeNodes },
      "license state",
    );
  }

  // No alert noise in audit mode while no license file exists yet.
  const warning = fileFound || licenseConfig.enforce ? licenseWarning(status) : null;
  if (warning) {
    if (await raiseOrUpdateSystemAlert(LICENSE_ALERT_TYPE, warning)) log.warn({ reason: warning }, "license alert raised");
  } else if (await resolveSystemAlert(LICENSE_ALERT_TYPE)) {
    log.info("license healthy — alert resolved");
  }
  return snapshot;
}

export function startLicenseEvaluator(log: FastifyBaseLogger): void {
  if (!licenseConfig.enforce) {
    log.warn("LICENSE_ENFORCE=false — license state is reported but nothing is restricted");
  }
  const run = () => {
    refreshLicense(log).catch((err) => log.error({ err }, "license check failed — keeping the previous state"));
  };
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}
