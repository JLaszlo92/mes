import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import QRCode from "qrcode";
import { pool } from "./db.js";

const require = createRequire(import.meta.url);
const otplib = require("otplib") as {
  authenticator: {
    options: { window?: number };
    generateSecret(): string;
    keyuri(user: string, service: string, secret: string): string;
    verify(opts: { token: string; secret: string }): boolean;
  };
};
const { authenticator } = otplib;

// 1 lépésnyi (±30s) tolerancia az órabeállítás-eltérésekre.
authenticator.options = { window: 1 };

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 perc

export function generateSecret(): string {
  return authenticator.generateSecret();
}

export function buildOtpAuthUrl(email: string, secret: string): string {
  return authenticator.keyuri(email, "MES", secret);
}

export async function buildQrCodeDataUrl(otpAuthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpAuthUrl);
}

export function verifyToken(secret: string, token: string): boolean {
  return authenticator.verify({ token, secret });
}

export async function setPendingMfaSecret(userId: string, secret: string): Promise<void> {
  await pool.query(`UPDATE users SET mfa_secret = $2 WHERE id = $1`, [userId, secret]);
}

export async function confirmMfaEnrollment(userId: string): Promise<void> {
  await pool.query(`UPDATE users SET mfa_enabled = true WHERE id = $1`, [userId]);
}

export async function getMfaSecret(userId: string): Promise<string | null> {
  const result = await pool.query<{ mfa_secret: string | null }>(
    `SELECT mfa_secret FROM users WHERE id = $1`,
    [userId],
  );
  return result.rows[0]?.mfa_secret ?? null;
}

export async function createPendingLogin(userId: string): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS);
  await pool.query(`INSERT INTO mfa_pending_logins (token, user_id, expires_at) VALUES ($1, $2, $3)`, [
    token,
    userId,
    expiresAt,
  ]);
  return { token, expiresAt: expiresAt.toISOString() };
}

/**
 * DELETE ... RETURNING egyetlen atomi lépésben "fogyasztja el" a pending
 * tokent — nem lehet kétszer felhasználni, még versenyhelyzetben sem.
 */
export async function consumePendingLogin(token: string): Promise<{ userId: string } | undefined> {
  const result = await pool.query<{ user_id: string }>(
    `DELETE FROM mfa_pending_logins WHERE token = $1 AND expires_at > now() RETURNING user_id`,
    [token],
  );
  return result.rows[0] ? { userId: result.rows[0].user_id } : undefined;
}