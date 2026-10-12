import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./db.js";
import { ADMIN_ROLE, effectivePermissions, type Permission } from "./permissions.js";
import type { RolePatch } from "./user-input.js";

export interface Role {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  /** The admin role: every permission, cannot be edited. */
  isLocked: boolean;
  userCount: number;
  permissions: Permission[];
}

type RoleRow = {
  id: string;
  name: string;
  description: string | null;
  is_system: boolean;
  user_count: string;
  granted: string[];
};

function toRole(r: RoleRow): Role {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    isSystem: r.is_system,
    isLocked: r.id === ADMIN_ROLE,
    userCount: Number(r.user_count),
    permissions: effectivePermissions(r.id, r.granted),
  };
}

const SELECT = `
  SELECT ro.*,
         (SELECT count(*) FROM users u WHERE u.role = ro.id AND u.is_active) AS user_count,
         ARRAY(SELECT permission FROM role_permissions rp WHERE rp.role_id = ro.id) AS granted
  FROM roles ro`;

export async function listRoles(): Promise<Role[]> {
  const result = await pool.query<RoleRow>(`${SELECT} ORDER BY ro.sort_order, ro.name`);
  return result.rows.map(toRole);
}

export async function getRole(id: string, db: Pick<PoolClient, "query"> = pool): Promise<Role | undefined> {
  const result = await db.query<RoleRow>(`${SELECT} WHERE ro.id = $1`, [id]);
  return result.rows[0] ? toRole(result.rows[0]) : undefined;
}

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function setPermissions(client: Pick<PoolClient, "query">, roleId: string, permissions: Permission[]) {
  await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
  if (permissions.length > 0) {
    await client.query(`INSERT INTO role_permissions (role_id, permission) SELECT $1, unnest($2::text[])`, [roleId, permissions]);
  }
}

export function createRole(input: RolePatch & { name: string }): Promise<Role> {
  return inTransaction(async (client) => {
    const id = `role_${randomBytes(4).toString("hex")}`;
    await client.query(`INSERT INTO roles (id, name, description, is_system, sort_order) VALUES ($1, $2, $3, false, 200)`, [
      id,
      input.name,
      input.description ?? null,
    ]);
    await setPermissions(client, id, input.permissions ?? []);
    return (await getRole(id, client))!;
  });
}

export interface RoleChange {
  previous: Role;
  current: Role;
}

/** `check` sees the result before COMMIT and may refuse it (e.g. nobody left who can manage users). */
export function updateRole(
  id: string,
  patch: RolePatch,
  check: (db: Pick<PoolClient, "query">) => Promise<string | null>,
): Promise<RoleChange | undefined | { refused: string }> {
  return inTransaction(async (client) => {
    const locked = await client.query(`SELECT 1 FROM roles WHERE id = $1 FOR UPDATE`, [id]);
    if (locked.rowCount === 0) return undefined;
    const previous = (await getRole(id, client))!;
    if (patch.name !== undefined || patch.description !== undefined) {
      await client.query(`UPDATE roles SET name = COALESCE($2, name), description = CASE WHEN $4 THEN $3 ELSE description END WHERE id = $1`, [
        id,
        patch.name ?? null,
        patch.description ?? null,
        patch.description !== undefined,
      ]);
    }
    if (patch.permissions && id !== ADMIN_ROLE) await setPermissions(client, id, patch.permissions);
    const refused = await check(client);
    if (refused) throw new RefusedChange(refused);
    return { previous, current: (await getRole(id, client))! };
  }).catch((err) => {
    if (err instanceof RefusedChange) return { refused: err.message };
    throw err;
  });
}

class RefusedChange extends Error {}

/** Only custom roles without users can be deleted. */
export function deleteRole(id: string): Promise<"not_found" | "system" | { inUse: number } | { deleted: Role }> {
  return inTransaction(async (client) => {
    const role = await getRole(id, client);
    if (!role) return "not_found" as const;
    if (role.isSystem) return "system" as const;
    const users = await client.query<{ n: string }>(`SELECT count(*) AS n FROM users WHERE role = $1`, [id]);
    const n = Number(users.rows[0]?.n ?? 0);
    if (n > 0) return { inUse: n };
    await client.query(`DELETE FROM roles WHERE id = $1`, [id]);
    return { deleted: role };
  });
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}
