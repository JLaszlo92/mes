import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { findValidSession } from "./sessions-repository.js";
import { pool } from "./db.js";
import { effectivePermissions, type Permission } from "./permissions.js";

export interface AuthedUser {
  id: string;
  /** Role id (roles.id), e.g. "admin", "planner". */
  role: string;
  email: string | null;
  name: string;
  permissions: ReadonlySet<Permission>;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthedUser;
  }
}

/** A display name for audit rows and screens: the name, else the e-mail, else the employee number. */
export function displayNameOf(row: { display_name: string | null; email: string | null; employee_number?: string | null }): string {
  return row.display_name?.trim() || row.email || (row.employee_number ? `#${row.employee_number}` : "unnamed user");
}

/**
 * Populates request.user from the Bearer token, if present and valid, with
 * the permissions of the user's role (one query). Does NOT reject anything:
 * auth-guard.ts decides, from the central route → permission map.
 */
export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorateRequest("user", undefined);

  app.addHook("onRequest", async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return;
    const token = header.slice("Bearer ".length);
    const session = await findValidSession(token);
    if (!session) return;
    const result = await pool.query<{ role: string; email: string | null; display_name: string | null; employee_number: string | null; granted: string[] }>(
      `SELECT u.role, u.email, u.display_name, u.employee_number,
              ARRAY(SELECT permission FROM role_permissions rp WHERE rp.role_id = u.role) AS granted
       FROM users u WHERE u.id = $1 AND u.is_active`,
      [session.userId],
    );
    const row = result.rows[0];
    if (row) {
      request.user = {
        id: session.userId,
        role: row.role,
        email: row.email,
        name: displayNameOf(row),
        permissions: new Set(effectivePermissions(row.role, row.granted)),
      };
    }
  });
});
