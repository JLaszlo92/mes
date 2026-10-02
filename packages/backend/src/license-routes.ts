import type { FastifyInstance } from "fastify";
import { requireRole } from "./auth-plugin.js";
import { countEdgeNodes, getLicenseSnapshot, refreshLicense } from "./license-service.js";
import { licenseGuardDecision, routeKind } from "./license-policy.js";

function summary() {
  const s = getLicenseSnapshot();
  const p = s.status.payload;
  return {
    enforce: s.enforce,
    checked: s.checked,
    state: s.checked ? s.status.state : "unknown",
    reason: s.status.reason,
    daysLeft: s.status.daysLeft,
    licenseFile: s.fileFound,
    customer: p?.customer ?? null,
    licenseId: p?.licenseId ?? null,
    serial: p?.serial ?? null,
    validUntil: p?.validUntil ?? null,
    graceDays: p?.graceDays ?? null,
    limits: p?.limits ?? null,
    usage: { edgeNodes: s.edgeNodes, terminals: null },
    checkedAt: s.checkedAt?.toISOString() ?? null,
  };
}

/**
 * Registers the license endpoints and the guard hook. Call it after the auth
 * plugin/guard and BEFORE the server starts listening.
 *
 * The guard restricts only configuration routes (license-policy.ts), only
 * when LICENSE_ENFORCE=true, and never before the first check finished.
 * In audit mode it just logs what it would have blocked.
 */
export function registerLicense(app: FastifyInstance): void {
  app.get("/api/license", async () => summary());

  app.post("/api/license/reload", { preHandler: requireRole("admin") }, async (request) => {
    await refreshLicense(request.log);
    return summary();
  });

  app.addHook("preHandler", async (request, reply) => {
    const snap = getLicenseSnapshot();
    if (!snap.checked) return;
    const pattern = request.routeOptions?.url;
    if (!pattern) return;
    const kind = routeKind(request.method, pattern);
    if (kind === "free") return;

    const edgeNodes = kind === "add-edge-node" ? await countEdgeNodes() : snap.edgeNodes;
    const decision = licenseGuardDecision(kind, snap.status, edgeNodes);
    if (decision.allowed) return;

    if (!snap.enforce) {
      request.log.warn(
        { license: "would_block", method: request.method, route: pattern, reason: decision.reason },
        "license audit mode: this request would be refused with LICENSE_ENFORCE=true",
      );
      return;
    }
    return reply.code(403).send({ error: "license_restricted", message: decision.reason });
  });
}
