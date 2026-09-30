import { createHash, randomBytes } from "node:crypto";
import { pool } from "./db.js";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 óra

/**
 * Az adatbázisban csak a token SHA-256 hash-e tárolódik (sql/028): aki az
 * adatbázist vagy egy mentést olvasni tudja, abból nem kap érvényes
 * bejelentkezést. A nyers token csak a kliensnél van. Az SQL oldali
 * megfelelője: encode(sha256(convert_to(token, 'UTF8')), 'hex').
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface Session {
  token: string;
  userId: string;
  expiresAt: string;
}

export async function createSession(userId: string): Promise<Session> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`, [
    hashSessionToken(token),
    userId,
    expiresAt,
  ]);
  // A nyers token egyszer, a login válaszban megy ki — tárolva sehol nincs.
  return { token, userId, expiresAt: expiresAt.toISOString() };
}

export async function findValidSession(token: string): Promise<{ userId: string } | undefined> {
  const result = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()`,
    [hashSessionToken(token)],
  );
  return result.rows[0] ? { userId: result.rows[0].user_id } : undefined;
}

export async function deleteSession(token: string): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashSessionToken(token)]);
}