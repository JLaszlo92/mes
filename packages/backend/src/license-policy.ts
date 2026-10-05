import { mayAddDevice, mayChangeConfiguration, type LicenseStatus } from "./license.js";

/**
 * Pure licensing policy (no I/O): configuration parsing, which routes the
 * license may restrict, and the user-facing warning text. See docs/LICENSING.md.
 *
 * Principle: the license can only ever restrict *configuration*. Data
 * collection (MQTT ingestion, the edge-node protocol, operator actions) is
 * never blocked, and anything uncertain fails open.
 */

export interface LicenseConfig {
  file: string;
  publicKeyFile: string;
  deviceCaFile: string;
  /** false = audit mode: compute and report the state, but never block. */
  enforce: boolean;
}

export function licenseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LicenseConfig {
  const raw = (env.LICENSE_ENFORCE ?? "false").toLowerCase();
  if (raw !== "true" && raw !== "false") {
    throw new Error(`LICENSE_ENFORCE must be "true" or "false" (got "${raw}")`);
  }
  return {
    file: env.LICENSE_FILE ?? "/etc/mes/license.json",
    publicKeyFile: env.LICENSE_PUBLIC_KEY_FILE ?? "/etc/mes/license.pub",
    deviceCaFile: env.LICENSE_DEVICE_CA_FILE ?? "/etc/mosquitto/certs/device-ca.crt",
    enforce: raw === "true",
  };
}

/** Route patterns (Fastify `routeOptions.url`) whose POST/PUT/PATCH are configuration. */
export const CONFIGURATION_PREFIXES: readonly string[] = [
  "/api/machine-registry",
  "/api/edge-nodes",
  "/api/edge-node-channels",
  "/api/alert-rules",
  // Plant hierarchy (plant-hierarchy-routes.ts).
  "/api/sites",
  "/api/areas",
  "/api/lines",
];

/** Never restricted, whatever the license says. */
const NEVER_RESTRICTED = new Set<string>([
  // The edge-node protocol carries production data.
  "POST /api/edge-nodes/claim",
  "POST /api/edge-nodes/heartbeat",
  "POST /api/edge-nodes/release",
  // A leaked token must always be rotatable.
  "POST /api/edge-nodes/:id/regenerate-token",
]);

export type RouteKind = "free" | "configuration" | "add-edge-node";

export function routeKind(method: string, pattern: string): RouteKind {
  const m = method.toUpperCase();
  if (m !== "POST" && m !== "PUT" && m !== "PATCH") return "free"; // reads and deletes
  if (NEVER_RESTRICTED.has(`${m} ${pattern}`)) return "free";
  if (m === "POST" && pattern === "/api/edge-nodes") return "add-edge-node";
  const inScope = CONFIGURATION_PREFIXES.some((p) => pattern === p || pattern.startsWith(`${p}/`));
  return inScope ? "configuration" : "free";
}

export function licenseGuardDecision(
  kind: RouteKind,
  status: LicenseStatus,
  edgeNodeCount: number,
): { allowed: boolean; reason: string } {
  if (kind === "free") return { allowed: true, reason: "ok" };
  if (kind === "add-edge-node") return mayAddDevice(status, "edgeNode", edgeNodeCount);
  return mayChangeConfiguration(status)
    ? { allowed: true, reason: "ok" }
    : { allowed: false, reason: `license ${status.state}: ${status.reason}` };
}

const dateOf = (iso: string): string => iso.slice(0, 10);

/** The text of the license system alert, or null if no alert is needed. */
export function licenseWarning(status: LicenseStatus, warnDays = 14): string | null {
  const until = status.payload ? dateOf(status.payload.validUntil) : "unknown";
  switch (status.state) {
    case "valid":
      return status.daysLeft !== null && status.daysLeft <= warnDays
        ? `The MES license expires in ${status.daysLeft} day(s) (${until}). Renew it to avoid restrictions.`
        : null;
    case "grace":
      return `The MES license period ended on ${until}; the grace period ends in ${status.daysLeft} day(s). After that the system becomes read-only for configuration (data collection continues).`;
    case "expired":
      return `The MES license expired (valid until ${until}). Configuration changes and adding devices are restricted; data collection continues. Install a renewed license file.`;
    case "invalid":
      return `The MES license is not valid: ${status.reason}.`;
  }
}
