import { createHash } from "node:crypto";

/**
 * mfa_pending_logins stores only the SHA-256 (hex) of the pending-login token, like `sessions` (sql/028): whoever can read the
 * table cannot finish a half-done login with it. The raw token exists only in the login response and in the client's request.
 */
export function hashPendingToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
