import { randomUUID, randomInt, createHmac, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./db.js";
import { hashPassword } from "./password.js";
import { effectivePermissions, type Permission } from "./permissions.js";
import { displayNameOf } from "./auth-plugin.js";

/**
 * Felhasználók és dolgozók egy táblában. A dashboardra az léphet be, akinek
 * e-mailje ÉS jelszava van (users_login_pair_chk); a terminálon a személyes,
 * 5 jegyű PIN azonosít. Egy dolgozónak lehet csak PIN-je (nincs e-mailje).
 */
export interface User {
  id: string;
  name: string;
  displayName: string | null;
  employeeNumber: string | null;
  email: string | null;
  role: string;
  roleName: string;
  isActive: boolean;
  createdAt: string;
  mfaEnabled: boolean;
  hasPassword: boolean;
  hasPin: boolean;
  pinSetAt: string | null;
  permissions: Permission[];
}

type UserRow = {
  id: string;
  display_name: string | null;
  employee_number: string | null;
  email: string | null;
  password_hash: string | null;
  role: string;
  role_name: string | null;
  is_active: boolean;
  created_at: string;
  mfa_enabled: boolean;
  pin_lookup: string | null;
  pin_set_at: string | null;
  granted: string[] | null;
};

function toUser(row: UserRow): User {
  return {
    id: row.id,
    name: displayNameOf(row),
    displayName: row.display_name,
    employeeNumber: row.employee_number,
    email: row.email,
    role: row.role,
    roleName: row.role_name ?? row.role,
    isActive: row.is_active,
    createdAt: row.created_at,
    mfaEnabled: row.mfa_enabled,
    hasPassword: row.password_hash !== null,
    hasPin: row.pin_lookup !== null,
    pinSetAt: row.pin_set_at,
    permissions: effectivePermissions(row.role, row.granted ?? []),
  };
}

const SELECT = `
  SELECT u.*, r.name AS role_name,
         ARRAY(SELECT permission FROM role_permissions rp WHERE rp.role_id = u.role) AS granted
  FROM users u
  LEFT JOIN roles r ON r.id = u.role`;

export async function listUsers(): Promise<User[]> {
  const result = await pool.query<UserRow>(`${SELECT} ORDER BY u.is_active DESC, lower(COALESCE(u.display_name, u.email, u.employee_number))`);
  return result.rows.map(toUser);
}

/** Active users only (for sign-in and sessions). */
export async function getUserById(id: string): Promise<User | undefined> {
  const result = await pool.query<UserRow>(`${SELECT} WHERE u.id = $1 AND u.is_active`, [id]);
  return result.rows[0] ? toUser(result.rows[0]) : undefined;
}

/** Any user, active or not (for the admin screens). */
export async function getAnyUser(id: string, db: Pick<PoolClient, "query"> = pool): Promise<User | undefined> {
  const result = await db.query<UserRow>(`${SELECT} WHERE u.id = $1`, [id]);
  return result.rows[0] ? toUser(result.rows[0]) : undefined;
}

/** Sign-in: case-insensitive e-mail, active users with a password only. */
export async function findUserByEmail(email: string): Promise<(User & { passwordHash: string }) | undefined> {
  const result = await pool.query<UserRow>(`${SELECT} WHERE lower(u.email) = lower($1) AND u.is_active AND u.password_hash IS NOT NULL`, [email]);
  const row = result.rows[0];
  return row ? { ...toUser(row), passwordHash: row.password_hash! } : undefined;
}

export interface UserWrite {
  displayName?: string | null;
  employeeNumber?: string | null;
  email?: string | null;
  /** Plain password; hashed here. null removes dashboard access (together with the e-mail). */
  password?: string | null;
  role?: string;
  isActive?: boolean;
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

export async function createUser(input: UserWrite & { role: string }): Promise<User> {
  const id = randomUUID();
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  await pool.query(
    `INSERT INTO users (id, display_name, employee_number, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, true))`,
    [id, input.displayName ?? null, input.employeeNumber ?? null, input.email ?? null, passwordHash, input.role, input.isActive ?? null],
  );
  return (await getAnyUser(id))!;
}

export interface UserChange {
  previous: User;
  current: User;
  changes: Record<string, { from: unknown; to: unknown }>;
}

const COLUMNS: Record<Exclude<keyof UserWrite, "password">, string> = {
  displayName: "display_name",
  employeeNumber: "employee_number",
  email: "email",
  role: "role",
  isActive: "is_active",
};

/**
 * Részleges módosítás egy tranzakcióban, a sor zárolva. A `check` a régi és
 * az új állapotot látja, és a COMMIT előtt megakadályozhatja a változást
 * (pl. az utolsó admin ne zárja ki magát). Jelszóváltásnál a felhasználó
 * minden sessionje törlődik.
 */
export function updateUser(
  id: string,
  patch: UserWrite,
  check: (previous: User, next: User, db: Pick<PoolClient, "query">) => Promise<string | null>,
): Promise<UserChange | undefined | { refused: string }> {
  return inTransaction(async (client) => {
    const locked = await client.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [id]);
    if (locked.rowCount === 0) return undefined;
    const previous = (await getAnyUser(id, client))!;
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [field, column] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, string][]) {
      if (field in patch) {
        values.push(patch[field] ?? null);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if ("password" in patch) {
      values.push(patch.password ? await hashPassword(patch.password) : null);
      sets.push(`password_hash = $${values.length}`);
      if (!patch.password) sets.push(`mfa_enabled = false`, `mfa_secret = NULL`);
    }
    if (sets.length > 0) await client.query(`UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, values);
    const current = (await getAnyUser(id, client))!;
    const refused = await check(previous, current, client);
    if (refused) {
      // Roll back by throwing; caught below.
      throw new RefusedChange(refused);
    }
    if ("password" in patch || (previous.isActive && !current.isActive)) {
      await client.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
    }
    const changes: UserChange["changes"] = {};
    for (const field of ["displayName", "employeeNumber", "email", "role", "isActive", "hasPassword"] as const) {
      if (previous[field] !== current[field]) changes[field] = { from: previous[field], to: current[field] };
    }
    if ("password" in patch && patch.password && previous.hasPassword) changes.password = { from: "set", to: "changed" };
    return { previous, current, changes };
  }).catch((err) => {
    if (err instanceof RefusedChange) return { refused: err.message };
    throw err;
  });
}

class RefusedChange extends Error {}

/** Active users that can still administer users and sign in to the dashboard. */
export async function countActiveUserAdmins(db: Pick<PoolClient, "query"> = pool): Promise<number> {
  const result = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM users u
     WHERE u.is_active AND u.password_hash IS NOT NULL
       AND (u.role = 'admin' OR EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = u.role AND rp.permission = 'admin.users'))`,
  );
  return Number(result.rows[0]?.n ?? 0);
}

export async function resetMfa(id: string): Promise<boolean> {
  const result = await pool.query(`UPDATE users SET mfa_enabled = false, mfa_secret = NULL, updated_at = now() WHERE id = $1`, [id]);
  await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

// ------------------------------------------------------------------ PIN

/**
 * A PIN-t a terminálon felhasználónév nélkül írják be, tehát a PIN-ből kell
 * megtalálni a dolgozót. Ezért nem lassú jelszó-hash, hanem HMAC-SHA256
 * keresőkulcs (egyedi index), a kulcs a szerver által generált titok
 * (app_secrets). Öt számjegy kevés: a védelmet a terminálonkénti
 * próbálkozás-korlát adja (auth-throttle.ts, "pin"), nem a tárolás.
 */
let hmacKey: Promise<Buffer> | undefined;

function pinKey(): Promise<Buffer> {
  hmacKey ??= (async () => {
    await pool.query(`INSERT INTO app_secrets (name, value) VALUES ('pin_hmac_key', $1) ON CONFLICT (name) DO NOTHING`, [
      randomBytes(32).toString("hex"),
    ]);
    const result = await pool.query<{ value: string }>(`SELECT value FROM app_secrets WHERE name = 'pin_hmac_key'`);
    return Buffer.from(result.rows[0]!.value, "hex");
  })().catch((err) => {
    hmacKey = undefined;
    throw err;
  });
  return hmacKey;
}

export const PIN_LENGTH = 5;

export function isPinFormat(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{5}$/.test(pin);
}

async function pinLookup(pin: string): Promise<string> {
  return createHmac("sha256", await pinKey()).update(pin).digest("hex");
}

/**
 * Új, véletlen PIN-t ad a felhasználónak (a régi azonnal érvénytelen). A
 * rendszer választja: így nincs 12345, és nem derül ki, hogy egy kézzel
 * választott kód már másé. A nyers PIN csak a válaszban létezik.
 */
export async function assignNewPin(userId: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const pin = String(randomInt(0, 100_000)).padStart(PIN_LENGTH, "0");
    if (/^(\d)\1{4}$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)) continue;
    try {
      const result = await pool.query(`UPDATE users SET pin_lookup = $2, pin_set_at = now(), updated_at = now() WHERE id = $1`, [userId, await pinLookup(pin)]);
      return (result.rowCount ?? 0) > 0 ? pin : undefined;
    } catch (err) {
      if (typeof err === "object" && err !== null && "code" in err && err.code === "23505") continue; // taken: try another
      throw err;
    }
  }
  throw new Error("could not find a free PIN (too many users for 5 digits?)");
}

export async function clearPin(userId: string): Promise<boolean> {
  const result = await pool.query(`UPDATE users SET pin_lookup = NULL, pin_set_at = NULL, updated_at = now() WHERE id = $1`, [userId]);
  return (result.rowCount ?? 0) > 0;
}

/** The active user with this PIN, or undefined. */
export async function findUserByPin(pin: string): Promise<User | undefined> {
  if (!isPinFormat(pin)) return undefined;
  const result = await pool.query<UserRow>(`${SELECT} WHERE u.pin_lookup = $1 AND u.is_active`, [await pinLookup(pin)]);
  return result.rows[0] ? toUser(result.rows[0]) : undefined;
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23503";
}
