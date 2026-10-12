import type { FastifyInstance, FastifyReply } from "fastify";
import { recordAuditEvent } from "./audit-repository.js";
import { PERMISSIONS } from "./permissions.js";
import { createRole, deleteRole, isUniqueViolation as isRoleUnique, listRoles, updateRole } from "./roles-repository.js";
import { parseRoleWrite, parseUserCreate, parseUserPatch } from "./user-input.js";
import {
  assignNewPin,
  clearPin,
  countActiveUserAdmins,
  createUser,
  getAnyUser,
  isForeignKeyViolation,
  isUniqueViolation,
  listUsers,
  resetMfa,
  updateUser,
} from "./users-repository.js";

/**
 * Felhasználók, szerepek, jogosultságok (Admin → Users, Admin → Roles).
 * Minden route-hoz `admin.users` kell (permissions.ts).
 *
 * Kizárás elleni szabályok: senki nem deaktiválhatja magát; és egy módosítás
 * után is kell maradnia legalább egy aktív, jelszóval belépni tudó
 * felhasználónak, aki felhasználókat kezelhet — különben a rendszert senki
 * nem tudná többé adminisztrálni.
 */

function fail(reply: FastifyReply, code: number, error: string, field?: string) {
  reply.code(code);
  return field ? { error, field } : { error };
}

const LOCKOUT = "this change would leave no active user who can sign in and manage users";

function dbError(reply: FastifyReply, err: unknown) {
  if (isUniqueViolation(err)) {
    const detail = String((err as { constraint?: string; detail?: string }).constraint ?? "");
    if (detail.includes("employee")) return fail(reply, 409, "another user has this employee number", "employeeNumber");
    return fail(reply, 409, "another user has this e-mail address", "email");
  }
  if (isForeignKeyViolation(err)) return fail(reply, 400, "unknown role", "role");
  if (typeof err === "object" && err !== null && "code" in err && err.code === "23514") {
    return fail(reply, 400, "dashboard sign-in needs both an e-mail and a password (or neither, for a terminal-only worker)", "password");
  }
  throw err;
}

export default async function userAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/users", async () => listUsers());

  app.post("/api/users", async (request, reply) => {
    const parsed = parseUserCreate(request.body);
    if (!parsed.ok) return fail(reply, 400, parsed.error, parsed.field);
    try {
      const user = await createUser(parsed.value);
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "user_created",
        target: user.id,
        details: { name: user.name, employeeNumber: user.employeeNumber, email: user.email, role: user.role, dashboardSignIn: user.hasPassword },
        ipAddress: request.ip,
      });
      reply.code(201);
      return user;
    } catch (err) {
      return dbError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/users/:id", async (request, reply) => {
    const parsed = parseUserPatch(request.body);
    if (!parsed.ok) return fail(reply, 400, parsed.error, parsed.field);
    const self = request.params.id === request.user!.id;
    if (self && parsed.value.isActive === false) return fail(reply, 409, "you cannot deactivate yourself", "isActive");
    try {
      const result = await updateUser(request.params.id, parsed.value, async (_previous, next, db) => {
        if (self && !next.permissions.includes("admin.users")) return "you cannot take away your own permission to manage users";
        return (await countActiveUserAdmins(db)) === 0 ? LOCKOUT : null;
      });
      if (!result) return fail(reply, 404, "unknown user");
      if ("refused" in result) return fail(reply, 409, result.refused);
      if (Object.keys(result.changes).length > 0) {
        await recordAuditEvent({ actorId: request.user!.id, action: "user_updated", target: request.params.id, details: { changes: result.changes }, ipAddress: request.ip });
      }
      return result.current;
    } catch (err) {
      return dbError(reply, err);
    }
  });

  // A new PIN is chosen by the server and returned ONCE; it is never stored in plain text.
  app.post<{ Params: { id: string } }>("/api/users/:id/pin", async (request, reply) => {
    const user = await getAnyUser(request.params.id);
    if (!user) return fail(reply, 404, "unknown user");
    const pin = await assignNewPin(user.id);
    if (!pin) return fail(reply, 404, "unknown user");
    await recordAuditEvent({ actorId: request.user!.id, action: "user_pin_set", target: user.id, details: { name: user.name, replaced: user.hasPin }, ipAddress: request.ip });
    return { pin };
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id/pin", async (request, reply) => {
    if (!(await clearPin(request.params.id))) return fail(reply, 404, "unknown user");
    await recordAuditEvent({ actorId: request.user!.id, action: "user_pin_cleared", target: request.params.id, ipAddress: request.ip });
    return { success: true };
  });

  app.post<{ Params: { id: string } }>("/api/users/:id/reset-mfa", async (request, reply) => {
    if (!(await resetMfa(request.params.id))) return fail(reply, 404, "unknown user");
    await recordAuditEvent({ actorId: request.user!.id, action: "user_mfa_reset", target: request.params.id, ipAddress: request.ip });
    return { success: true };
  });

  // ------------------------------------------------------------- roles

  app.get("/api/roles", async () => ({ roles: await listRoles(), permissions: PERMISSIONS }));

  // Names only, for any signed-in user (e.g. who an alert rule notifies).
  app.get("/api/role-names", async () => (await listRoles()).map((r) => ({ id: r.id, name: r.name })));

  app.post("/api/roles", async (request, reply) => {
    const parsed = parseRoleWrite(request.body, true);
    if (!parsed.ok) return fail(reply, 400, parsed.error, parsed.field);
    try {
      const role = await createRole({ ...parsed.value, name: parsed.value.name! });
      await recordAuditEvent({ actorId: request.user!.id, action: "role_created", target: role.id, details: { name: role.name, permissions: role.permissions }, ipAddress: request.ip });
      reply.code(201);
      return role;
    } catch (err) {
      if (isRoleUnique(err)) return fail(reply, 409, "a role with this name already exists", "name");
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/roles/:id", async (request, reply) => {
    const parsed = parseRoleWrite(request.body, false);
    if (!parsed.ok) return fail(reply, 400, parsed.error, parsed.field);
    if (request.params.id === "admin" && parsed.value.permissions) {
      return fail(reply, 409, "the Admin role always has every permission", "permissions");
    }
    try {
      const result = await updateRole(request.params.id, parsed.value, async (db) => ((await countActiveUserAdmins(db)) === 0 ? LOCKOUT : null));
      if (!result) return fail(reply, 404, "unknown role");
      if ("refused" in result) return fail(reply, 409, result.refused, "permissions");
      const added = result.current.permissions.filter((p) => !result.previous.permissions.includes(p));
      const removed = result.previous.permissions.filter((p) => !result.current.permissions.includes(p));
      if (added.length > 0 || removed.length > 0 || result.previous.name !== result.current.name || result.previous.description !== result.current.description) {
        await recordAuditEvent({
          actorId: request.user!.id,
          action: "role_updated",
          target: request.params.id,
          details: { name: result.current.name, added, removed, ...(result.previous.name !== result.current.name ? { renamedFrom: result.previous.name } : {}) },
          ipAddress: request.ip,
        });
      }
      return result.current;
    } catch (err) {
      if (isRoleUnique(err)) return fail(reply, 409, "a role with this name already exists", "name");
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>("/api/roles/:id", async (request, reply) => {
    const result = await deleteRole(request.params.id);
    if (result === "not_found") return fail(reply, 404, "unknown role");
    if (result === "system") return fail(reply, 409, "built-in roles cannot be deleted (rename them or change their permissions)");
    if ("inUse" in result) return fail(reply, 409, `${result.inUse} user(s) still have this role`);
    await recordAuditEvent({ actorId: request.user!.id, action: "role_deleted", target: request.params.id, details: { name: result.deleted.name }, ipAddress: request.ip });
    return { success: true };
  });
}
