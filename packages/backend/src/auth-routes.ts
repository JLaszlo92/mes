import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { findUserByEmail, getUserById } from "./users-repository.js";
import { createSession } from "./sessions-repository.js";
import { hashPassword, verifyPassword } from "./password.js";
import { recordAuditEvent } from "./audit-repository.js";
import { createPendingLogin, consumePendingLogin, getMfaSecret, verifyToken } from "./mfa-repository.js";
import {
  checkThrottle,
  clearLoginThrottle,
  clearMfaThrottle,
  loginThrottleKeys,
  mfaThrottleKeys,
  POLICIES,
  registerThrottleFailure,
  throttleMessage,
  type ThrottleScope,
} from "./auth-throttle.js";

/**
 * POST /api/auth/login és POST /api/auth/mfa/login — próbálkozás-korlátozással
 * (auth-throttle.ts). Mindkettő az auth guard PUBLIC_ROUTES listáján van.
 */

// Nem létező fióknál is lefut egy ugyanolyan lassú jelszó-ellenőrzés ezzel az
// álhash-sel, így a válaszidőből nem derül ki, létezik-e a fiók.
let dummyPasswordHash: Promise<string> | undefined;
function getDummyPasswordHash(): Promise<string> {
  dummyPasswordHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyPasswordHash;
}

function rejectThrottled(reply: FastifyReply, retryAfterSeconds: number) {
  reply.header("Retry-After", String(retryAfterSeconds));
  reply.code(429);
  return { error: throttleMessage(retryAfterSeconds) };
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  // Előre elkészül, hogy már az első kérésnél se látszódjon időbeli eltérés.
  await getDummyPasswordHash();

  app.post<{ Body: { email?: unknown; password?: unknown } }>("/api/auth/login", async (request, reply) => {
    const email = typeof request.body?.email === "string" ? request.body.email.trim() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!email || !password) {
      reply.code(400);
      return { error: "email and password are required" };
    }

    const keys = loginThrottleKeys(email, request.ip);
    const blocked = await checkThrottle(keys);
    if (blocked) {
      // Zárolás alatt a jelszót nem is ellenőrizzük. Journalba megy, nem az
      // audit logba: támadás alatt minden elutasított kérés elárasztaná.
      request.log.warn({ authThrottle: "blocked", scope: blocked.scope, ip: request.ip }, "login blocked by throttle");
      return rejectThrottled(reply, blocked.retryAfterSeconds);
    }

    const user = await findUserByEmail(email);
    const passwordOk = user
      ? await verifyPassword(password, user.passwordHash)
      : (await verifyPassword(password, await getDummyPasswordHash()), false);

    if (!user || !passwordOk) {
      await recordAuditEvent({ actorEmail: email, action: "login_failed", ipAddress: request.ip });
      const newlyLocked = await registerThrottleFailure(keys);
      await auditLocks(newlyLocked, email, undefined, request.ip);
      reply.code(401);
      return { error: "invalid email or password" };
    }

    // A jelszó helyes: a fiók+IP és a fiókszintű számláló nullázódik (az IP-szintű nem).
    await clearLoginThrottle(email, request.ip);

    if (user.mfaEnabled) {
      const pending = await createPendingLogin(user.id);
      return { mfaRequired: true, pendingToken: pending.token, expiresAt: pending.expiresAt };
    }

    const session = await createSession(user.id);
    await recordAuditEvent({ actorId: user.id, actorEmail: user.email, action: "login_success", ipAddress: request.ip });

    // PRD 8.3: admin/manager esetén kötelező az MFA — ha még nincs
    // beállítva, jelezzük, hogy a kliensnek azonnal be kell állítania.
    const mfaSetupRequired = (user.role === "admin" || user.role === "manager") && !user.mfaEnabled;
    return { token: session.token, role: user.role, expiresAt: session.expiresAt, mfaSetupRequired };
  });

  app.post<{ Body: { pendingToken?: unknown; code?: unknown } }>("/api/auth/mfa/login", async (request, reply) => {
    const pendingToken = typeof request.body?.pendingToken === "string" ? request.body.pendingToken : "";
    const code = typeof request.body?.code === "string" ? request.body.code.trim() : "";
    if (!pendingToken || !code) {
      reply.code(400);
      return { error: "pendingToken and code are required" };
    }

    const pending = await consumePendingLogin(pendingToken);
    if (!pending) {
      reply.code(401);
      return { error: "invalid or expired login attempt — please sign in again" };
    }

    // Saját számláló: a sikeres jelszó nullázza a login-számlálót, így enélkül
    // a jelszó birtokában a 6 jegyű kód végigpróbálgatható lenne.
    const keys = mfaThrottleKeys(pending.userId, request.ip);
    const blocked = await checkThrottle(keys);
    if (blocked) {
      request.log.warn({ authThrottle: "blocked", scope: blocked.scope, ip: request.ip }, "mfa login blocked by throttle");
      return rejectThrottled(reply, blocked.retryAfterSeconds);
    }

    const secret = await getMfaSecret(pending.userId);
    if (!secret || !verifyToken(secret, code)) {
      await recordAuditEvent({ actorId: pending.userId, action: "mfa_failed", ipAddress: request.ip });
      const newlyLocked = await registerThrottleFailure(keys);
      await auditLocks(newlyLocked, undefined, pending.userId, request.ip);
      reply.code(401);
      return { error: "invalid code" };
    }

    const user = await getUserById(pending.userId);
    if (!user) {
      reply.code(404);
      return { error: "user not found" };
    }

    await clearMfaThrottle(user.id);
    const session = await createSession(user.id);
    await recordAuditEvent({ actorId: user.id, actorEmail: user.email, action: "login_success", ipAddress: request.ip });
    return { token: session.token, role: user.role, expiresAt: session.expiresAt };
  });
}

/** A zárolás MEGTÖRTÉNTE kerül az audit logba (a zárolás alatti kérések csak a journalba). */
async function auditLocks(scopes: ThrottleScope[], email: string | undefined, userId: string | undefined, ip: string) {
  for (const scope of scopes) {
    await recordAuditEvent({
      actorId: userId ?? null,
      actorEmail: email ?? null,
      action: scope === "mfa" ? "mfa_locked" : "login_locked",
      details: { scope, lockMinutes: POLICIES[scope].lockMinutes },
      ipAddress: ip,
    });
  }
}
