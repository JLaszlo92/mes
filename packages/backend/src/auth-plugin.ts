import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { findValidSession } from "./sessions-repository.js";
import { pool } from "./db.js";
import type { UserRole } from "./users-repository.js";

export interface AuthedUser {
  id: string;
  role: UserRole;
  email: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthedUser;
  }
}

/**
 * Populates request.user from the Bearer token, if present and valid.
 * Does NOT reject unauthenticated requests itself — routes that need
 * protection use requireRole() as an explicit preHandler, so which routes
 * are public stays visible at the route definition, not buried in a
 * global default.
 */
export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorateRequest("user", undefined);

  app.addHook("onRequest", async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return;
    const token = header.slice("Bearer ".length);
    const session = await findValidSession(token);
    if (!session) return;
    const result = await pool.query<{ role: UserRole; email: string }>(
      `SELECT role, email FROM users WHERE id = $1 AND is_active`,
      [session.userId],
    );
    if (result.rows[0]) {
      request.user = { id: session.userId, role: result.rows[0].role, email: result.rows[0].email };
    }
  });
});

export function requireRole(...roles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      reply.code(401);
      throw new Error("authentication required");
    }
    if (!roles.includes(request.user.role)) {
      reply.code(403);
      throw new Error("insufficient role");
    }
  };
}