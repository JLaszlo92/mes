import { createHash, createPublicKey, verify, X509Certificate } from "node:crypto";

/**
 * License verification (pure: no database, no I/O). See docs/LICENSING.md.
 *
 * A license file is JSON: { format, payload, signature } where `payload` is
 * the base64url of the JSON payload bytes and `signature` an Ed25519
 * signature over `"mes-license-v1\n" + payloadBytes`. The signature covers
 * the exact bytes, so no canonical JSON is needed. The vendor's private key
 * stays offline; the backend only holds the public key.
 */

export const LICENSE_FORMAT = "mes-license-v1";
const DOMAIN = Buffer.from(`${LICENSE_FORMAT}\n`);
const DAY_MS = 86_400_000;
const NOT_YET_VALID_TOLERANCE_MS = DAY_MS;

export interface LicensePayload {
  v: 1;
  licenseId: string;
  customer: string;
  /** Strictly increasing per vendor; an older serial never replaces a newer one. */
  serial: number;
  issuedAt: string;
  validFrom: string;
  validUntil: string;
  /** Days after validUntil with full function and warnings only. */
  graceDays: number;
  /** sha256 (hex) of the device CA root certificate (DER): ties the license to one installation. */
  deviceCaSha256: string;
  limits: { edgeNodes: number; terminals: number };
}

export type LicenseState = "valid" | "grace" | "expired" | "invalid";

export interface LicenseStatus {
  state: LicenseState;
  reason: string;
  payload: LicensePayload | null;
  /** valid: days until validUntil; grace: days until the grace period ends; else null. */
  daysLeft: number | null;
}

export interface VerifyOptions {
  publicKeyPem: string;
  /** sha256 hex of this installation's device CA root certificate. */
  deviceCaSha256: string;
  now: Date;
  /** Highest serial installed so far (rollback protection). */
  minSerial?: number;
}

export type DeviceKind = "edgeNode" | "terminal";

function invalid(reason: string, payload: LicensePayload | null = null): LicenseStatus {
  return { state: "invalid", reason, payload, daysLeft: null };
}

function parseEnvelope(text: string): { payloadBytes: Buffer; signature: Buffer } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.format !== LICENSE_FORMAT || typeof o.payload !== "string" || typeof o.signature !== "string") {
    return null;
  }
  return { payloadBytes: Buffer.from(o.payload, "base64url"), signature: Buffer.from(o.signature, "base64url") };
}

const isNonEmptyString = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const isCount = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;

function parsePayload(bytes: Buffer): LicensePayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const limits = o.limits as Record<string, unknown> | undefined;
  if (
    o.v !== 1 ||
    !isNonEmptyString(o.licenseId) ||
    !isNonEmptyString(o.customer) ||
    !isCount(o.serial) || o.serial < 1 ||
    !isNonEmptyString(o.issuedAt) || Number.isNaN(Date.parse(o.issuedAt)) ||
    !isNonEmptyString(o.validFrom) || Number.isNaN(Date.parse(o.validFrom)) ||
    !isNonEmptyString(o.validUntil) || Number.isNaN(Date.parse(o.validUntil)) ||
    !isCount(o.graceDays) || o.graceDays > 365 ||
    !isNonEmptyString(o.deviceCaSha256) || !/^[0-9a-f]{64}$/.test(o.deviceCaSha256) ||
    typeof limits !== "object" || limits === null ||
    !isCount(limits.edgeNodes) || !isCount(limits.terminals)
  ) {
    return null;
  }
  if (Date.parse(o.validUntil) <= Date.parse(o.validFrom)) return null;
  return {
    v: 1,
    licenseId: o.licenseId,
    customer: o.customer,
    serial: o.serial,
    issuedAt: o.issuedAt,
    validFrom: o.validFrom,
    validUntil: o.validUntil,
    graceDays: o.graceDays,
    deviceCaSha256: o.deviceCaSha256,
    limits: { edgeNodes: limits.edgeNodes, terminals: limits.terminals },
  };
}

export function verifyLicense(text: string, opts: VerifyOptions): LicenseStatus {
  const env = parseEnvelope(text);
  if (!env) return invalid("not a MES license file");

  let signatureOk = false;
  try {
    signatureOk = verify(null, Buffer.concat([DOMAIN, env.payloadBytes]), createPublicKey(opts.publicKeyPem), env.signature);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return invalid("signature does not verify");

  const payload = parsePayload(env.payloadBytes);
  if (!payload) return invalid("payload malformed or unsupported version");
  if (payload.deviceCaSha256 !== opts.deviceCaSha256.toLowerCase()) {
    return invalid("license was issued for a different installation (device CA mismatch)", payload);
  }
  if (opts.minSerial !== undefined && payload.serial < opts.minSerial) {
    return invalid("license is older than one already installed", payload);
  }

  const t = opts.now.getTime();
  const from = Date.parse(payload.validFrom);
  const until = Date.parse(payload.validUntil);
  if (t < from - NOT_YET_VALID_TOLERANCE_MS) return invalid("license is not valid yet", payload);
  if (t <= until) {
    return { state: "valid", reason: "ok", payload, daysLeft: Math.ceil((until - t) / DAY_MS) };
  }
  const graceEnd = until + payload.graceDays * DAY_MS;
  if (t <= graceEnd) {
    return { state: "grace", reason: "license period ended, grace period running", payload, daysLeft: Math.ceil((graceEnd - t) / DAY_MS) };
  }
  return { state: "expired", reason: "license and grace period ended", payload, daysLeft: null };
}

/**
 * Data collection must never depend on the license. Only configuration
 * changes and adding devices do: allowed while valid or in the grace period.
 */
export function mayChangeConfiguration(status: LicenseStatus): boolean {
  return status.state === "valid" || status.state === "grace";
}

export function mayAddDevice(
  status: LicenseStatus,
  kind: DeviceKind,
  currentCount: number,
): { allowed: boolean; reason: string } {
  if (!mayChangeConfiguration(status) || !status.payload) {
    return { allowed: false, reason: `license ${status.state}: ${status.reason}` };
  }
  const limit = kind === "edgeNode" ? status.payload.limits.edgeNodes : status.payload.limits.terminals;
  if (currentCount >= limit) {
    return { allowed: false, reason: `${kind} limit reached (${currentCount}/${limit})` };
  }
  return { allowed: true, reason: "ok" };
}

/** sha256 (hex) of the DER of a PEM certificate, e.g. the device CA root.crt. */
export function deviceCaFingerprint(pem: string): string {
  return createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");
}
