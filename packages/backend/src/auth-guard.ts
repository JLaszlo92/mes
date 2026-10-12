import type { FastifyInstance } from "fastify";
import { AUTHENTICATED, PERMISSIONS, requirementFor } from "./permissions.js";

/**
 * Alapértelmezetten tiltó (deny-by-default) hitelesítés minden route-ra.
 * Ami nincs a PUBLIC_ROUTES listán, ahhoz érvényes session kell, és a
 * permissions.ts ROUTE_PERMISSIONS szerinti jogosultság (írási route, ami
 * nincs ott felsorolva, 403 — elfelejtett route nem lehet nyitva).
 *
 * AUTH_MODE:
 *  - "enforce" (alapértelmezett): hitelesítetlen kérésre 401.
 *  - "report": átengedi a kérést, de warn szinten naplózza, hogy enforce
 *    módban elutasítaná. Csak átállási időszakra.
 */

export type AuthMode = "enforce" | "report";

/**
 * Szándékosan nyilvános route-ok, "METÓDUS /route-minta" alakban.
 * Új elem csak indoklással kerülhet ide.
 */
const PUBLIC_ROUTES = new Set<string>([
  "GET /health",
  // Bejelentkezés — itt még nincs session.
  "POST /api/auth/login",
  "POST /api/auth/mfa/login",
  // Kijelentkezés lejárt tokennel is legyen hibamentes.
  "POST /api/auth/logout",
  // Edge node-ok: saját tokennel hitelesítenek a body-ban, nem emberi sessionnel.
  "POST /api/edge-nodes/claim",
  "POST /api/edge-nodes/heartbeat",
  "POST /api/edge-nodes/release",
  // Terminálok: a párosított eszköz saját tokennel (X-Terminal-Token) azonosítja
  // magát, a módosításokhoz a dolgozó PIN-jével kapott jegy kell (terminal-routes.ts).
  "GET /api/terminal/:terminalId/state",
  "POST /api/terminal/:terminalId/unlock",
  "POST /api/terminal/:terminalId/lock",
  "POST /api/terminal/:terminalId/work-orders/:workOrderId/start",
  "POST /api/terminal/:terminalId/work-orders/:workOrderId/complete",
  "POST /api/terminal/:terminalId/fault-reports",
  "POST /api/terminal/:terminalId/machines/:machineId/status",
  "POST /api/terminal/:terminalId/work-orders/:workOrderId/instruction",
  "GET /api/terminal/:terminalId/instruction-files/:fileId",
  "GET /api/terminal/:terminalId/quality-checks/:checkId",
  "POST /api/terminal/:terminalId/quality-checks/:checkId/measurements",
  "POST /api/terminal/:terminalId/quality-checks/:checkId/release",
  "POST /api/terminal/:terminalId/work-orders/:workOrderId/spot-check",
  // A böngésző WebSocketen nem küld Authorization headert: a /ws-t a
  // route maga hitelesíti egyszer használható tickettel (ws-tickets.ts).
  "GET /ws",
]);

export function authModeFromEnv(value: string | undefined = process.env.AUTH_MODE): AuthMode {
  if (value === undefined || value === "" || value === "enforce") return "enforce";
  if (value === "report") return "report";
  // Elgépelt érték ne kapcsolja ki csendben a védelmet.
  throw new Error(`invalid AUTH_MODE "${value}" — expected "enforce" or "report"`);
}

export function isPublicRoute(method: string, routePattern: string | undefined): boolean {
  if (!routePattern) return false;
  // A Fastify minden GET route-hoz automatikusan HEAD-et is regisztrál.
  const normalizedMethod = method === "HEAD" ? "GET" : method;
  return PUBLIC_ROUTES.has(`${normalizedMethod} ${routePattern}`);
}

/** Az authPlugin regisztrálása UTÁN kell meghívni. */
export function registerAuthGuard(app: FastifyInstance, mode: AuthMode): void {
  if (mode === "report") {
    app.log.warn("AUTH_MODE=report — unauthenticated requests are logged but NOT rejected; switch back to enforce after the transition");
  } else {
    app.log.info("auth guard active (AUTH_MODE=enforce)");
  }

  app.addHook("preHandler", async (request, reply) => {
    if (request.method === "OPTIONS") return;
    const route = request.routeOptions?.url;
    if (isPublicRoute(request.method, route)) return;

    if (request.user) {
      const needed = requirementFor(request.method, route);
      if (needed === AUTHENTICATED) return;
      if (needed !== "deny" && request.user.permissions.has(needed)) return;
      const label = needed === "deny" ? null : (PERMISSIONS.find((p) => p.key === needed)?.label ?? needed);
      request.log.info({ authGuard: "forbidden", method: request.method, route, permission: needed, userId: request.user.id }, "permission denied");
      return reply.code(403).send(
        label ? { error: `you do not have the permission: ${label}`, permission: needed } : { error: "this action is not allowed for any role" },
      );
    }

    if (mode === "report") {
      request.log.warn(
        { authGuard: "would_reject", method: request.method, route: route ?? request.url, ip: request.ip },
        "unauthenticated request would be rejected in enforce mode",
      );
      return;
    }

    return reply.code(401).send({ error: "authentication required" });
  });
}
