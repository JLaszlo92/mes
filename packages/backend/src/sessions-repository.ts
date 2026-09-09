import { randomBytes } from "node:crypto";
import { pool } from "./db.js";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 óra

export interface Session {
  token: string;
  userId: string;
  expiresAt: string;
}

export async function createSession(userId: string): Promise<Session> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)`, [
    token,
    userId,
    expiresAt,
  ]);
  return { token, userId, expiresAt: expiresAt.toISOString() };
}

export async function findValidSession(token: string): Promise<{ userId: string } | undefined> {
  const result = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM sessions WHERE token = $1 AND expires_at > now()`,
    [token],
  );
  return result.rows[0] ? { userId: result.rows[0].user_id } : undefined;
}

export async function deleteSession(token: string): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
}