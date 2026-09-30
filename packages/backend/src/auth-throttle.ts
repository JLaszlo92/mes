import { pool } from "./db.js";

/**
 * Bejelentkezési próbálkozások korlátozása (brute force és password
 * spraying ellen). Számlálók az auth_throttle táblában (sql/032), így egy
 * backend-újraindítás nem oldja fel őket.
 *
 * Szabályok (a PAIR a fő védelem, a többi a megkerülése ellen):
 *  - pair:    ugyanarról az IP-ről ugyanarra a fiókra 5 hiba / 15 perc → 15 perc zár.
 *             A zár a fiók+IP PÁRRA vonatkozik: egy támadó nem tudja kizárni
 *             a jogos felhasználót, aki más gépről (a saját termináljáról) belép.
 *  - account: egy fiókra, bármely IP-ről 20 hiba / 60 perc → 15 perc zár
 *             (sok IP-ről érkező támadás ellen).
 *  - ip:      egy IP-ről, bármely fiókra 30 hiba / 15 perc → 15 perc zár
 *             (password spraying ellen; bőven elég egy megosztott terminálnak).
 *  - mfa:     egy felhasználó MFA kódjaira 5 hiba / 15 perc → 15 perc zár.
 *             Kell, mert a sikeres jelszó nullázza a pair-számlálót, így
 *             enélkül a jelszó birtokában a 6 jegyű kód végigpróbálgatható.
 *
 * Az azonosító a normalizált (kisbetűs, trimmelt) e-mail, és nem létező
 * fiókra is ugyanúgy számol — a válasz így nem árulja el, létezik-e a fiók,
 * és kis-nagybetűs változatokkal sem kerülhető meg.
 */

interface Policy {
  limit: number;
  windowMinutes: number;
  lockMinutes: number;
}

export const POLICIES = {
  pair: { limit: 5, windowMinutes: 15, lockMinutes: 15 },
  account: { limit: 20, windowMinutes: 60, lockMinutes: 15 },
  ip: { limit: 30, windowMinutes: 15, lockMinutes: 15 },
  mfa: { limit: 5, windowMinutes: 15, lockMinutes: 15 },
} satisfies Record<string, Policy>;

export type ThrottleScope = keyof typeof POLICIES;

export interface ThrottleKey {
  scope: ThrottleScope;
  key: string;
}

export function normalizeIdentifier(email: string): string {
  return email.trim().toLowerCase();
}

export function loginThrottleKeys(email: string, ip: string): ThrottleKey[] {
  const id = normalizeIdentifier(email);
  return [
    { scope: "pair", key: `pair:${id}|${ip}` },
    { scope: "account", key: `account:${id}` },
    { scope: "ip", key: `ip:${ip}` },
  ];
}

export function mfaThrottleKeys(userId: string, ip: string): ThrottleKey[] {
  return [
    { scope: "mfa", key: `mfa:${userId}` },
    { scope: "ip", key: `ip:${ip}` },
  ];
}

/** Zárolva van-e bármelyik kulcs? Ha igen, a leghosszabb hátralévő idő. */
export async function checkThrottle(
  keys: ThrottleKey[],
): Promise<{ scope: ThrottleScope; retryAfterSeconds: number } | undefined> {
  const result = await pool.query<{ key: string; seconds: number }>(
    `SELECT key, CEIL(EXTRACT(EPOCH FROM (locked_until - now())))::int AS seconds
     FROM auth_throttle
     WHERE key = ANY($1::text[]) AND locked_until > now()
     ORDER BY locked_until DESC
     LIMIT 1`,
    [keys.map((k) => k.key)],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const scope = keys.find((k) => k.key === row.key)?.scope ?? "pair";
  return { scope, retryAfterSeconds: Math.max(1, row.seconds) };
}

/**
 * Egy sikertelen próbálkozás rögzítése minden kulcson. Lejárt ablaknál vagy
 * lejárt zárnál a számláló újraindul. Visszatér: azok a szabályok, amelyek
 * EZZEL a próbálkozással léptek zárolt állapotba (auditáláshoz).
 */
export async function registerThrottleFailure(keys: ThrottleKey[]): Promise<ThrottleScope[]> {
  const newlyLocked: ThrottleScope[] = [];
  for (const { scope, key } of keys) {
    const policy: Policy = POLICIES[scope];
    const window = `${policy.windowMinutes} minutes`;
    const counted = await pool.query<{ failures: number }>(
      `INSERT INTO auth_throttle (key, failures, window_started_at) VALUES ($1, 1, now())
       ON CONFLICT (key) DO UPDATE SET
         failures = CASE
           WHEN auth_throttle.window_started_at < now() - $2::interval
             OR (auth_throttle.locked_until IS NOT NULL AND auth_throttle.locked_until <= now())
           THEN 1 ELSE auth_throttle.failures + 1 END,
         window_started_at = CASE
           WHEN auth_throttle.window_started_at < now() - $2::interval
             OR (auth_throttle.locked_until IS NOT NULL AND auth_throttle.locked_until <= now())
           THEN now() ELSE auth_throttle.window_started_at END,
         locked_until = CASE WHEN auth_throttle.locked_until > now() THEN auth_throttle.locked_until ELSE NULL END
       RETURNING failures`,
      [key, window],
    );
    const failures = counted.rows[0]?.failures ?? 0;
    if (failures >= policy.limit) {
      const locked = await pool.query(
        `UPDATE auth_throttle SET locked_until = now() + $2::interval
         WHERE key = $1 AND (locked_until IS NULL OR locked_until <= now())`,
        [key, `${policy.lockMinutes} minutes`],
      );
      if ((locked.rowCount ?? 0) > 0) newlyLocked.push(scope);
    }
  }
  return newlyLocked;
}

/**
 * Sikeres jelszó után: a fiók+IP pár és a fiókszintű számláló nullázódik.
 * Az IP-számláló NEM — egy ismert jelszó ne nullázhassa a password spraying
 * elleni védelmet. Közben a régi, már nem zárolt sorok is törlődnek.
 */
export async function clearLoginThrottle(email: string, ip: string): Promise<void> {
  const [pair, account] = loginThrottleKeys(email, ip);
  await pool.query(`DELETE FROM auth_throttle WHERE key = ANY($1::text[])`, [[pair!.key, account!.key]]);
  await pool.query(
    `DELETE FROM auth_throttle
     WHERE window_started_at < now() - interval '1 day' AND (locked_until IS NULL OR locked_until < now())`,
  );
}

export async function clearMfaThrottle(userId: string): Promise<void> {
  await pool.query(`DELETE FROM auth_throttle WHERE key = $1`, [`mfa:${userId}`]);
}

export function throttleMessage(retryAfterSeconds: number): string {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}
