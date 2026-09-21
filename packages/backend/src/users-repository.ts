import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
import { hashPassword } from "./password.js";

export type UserRole = "operator" | "supervisor" | "maintenance" | "manager" | "admin";

export interface User {
  id: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  mfaEnabled: boolean;
}

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  is_active: boolean;
  created_at: string;
  mfa_enabled: boolean;
};

function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, role: row.role, isActive: row.is_active, createdAt: row.created_at, mfaEnabled: row.mfa_enabled,};
}

export async function createUser(email: string, password: string, role: UserRole): Promise<User> {
  const passwordHash = await hashPassword(password);
  const result = await pool.query<UserRow>(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *`,
    [randomUUID(), email, passwordHash, role],
  );
  const row = result.rows[0];
  if (!row) throw new Error("INSERT ... RETURNING unexpectedly returned no row");
  return toUser(row);
}

export async function findUserByEmail(
  email: string,
): Promise<(User & { passwordHash: string }) | undefined> {
  const result = await pool.query<UserRow>(`SELECT * FROM users WHERE email = $1 AND is_active`, [email]);
  const row = result.rows[0];
  return row ? { ...toUser(row), passwordHash: row.password_hash } : undefined;
}

export async function listUsers(): Promise<User[]> {
  const result = await pool.query<UserRow>(`SELECT * FROM users ORDER BY email`);
  return result.rows.map(toUser);
}

export async function getUserById(id: string): Promise<User | undefined> {
  const result = await pool.query<UserRow>(`SELECT * FROM users WHERE id = $1 AND is_active`, [id]);
  return result.rows[0] ? toUser(result.rows[0]) : undefined;
}