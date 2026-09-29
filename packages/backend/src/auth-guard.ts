import type { FastifyInstance } from "fastify";

/**
 * Alapértelmezetten tiltó (deny-by-default) hitelesítés minden route-ra.
 * Ami nincs a PUBLIC_ROUTES listán, ahhoz érvényes session kell; a
 * szerepkör-ellenőrzés (`requireRole`) ezen felül, route-szinten marad.
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
  // ISMERT RÉS: böngészőből WebSocketen nem küldhető Authorization header.
  // Lezárása: rövid életű, egyszer használható ws-ticket (külön körben).
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
    if (request.user) return;

    const route = request.routeOptions?.url;
    if (isPublicRoute(request.method, route)) return;

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
