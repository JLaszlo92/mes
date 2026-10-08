import type { FastifyInstance } from "fastify";

/**
 * A database that cannot be reached answers HTTP 503, not 500 (chaos slice 10 follow-up).
 *
 * With Postgres stopped every query fails with a connection error. Fastify's default handler turned that
 * into a plain 500 "Internal Server Error", which a dashboard cannot tell from a bug. A 503 with
 * `code: "database_unavailable"` and `Retry-After` says what is wrong and that it will pass.
 * Every other error is handed on unchanged (validation 400, 404, real 500).
 */

export interface DatabaseTarget {
  host: string;
  port: number;
}

/** Host and port of the database URL; null if there is none or it is a unix socket / unreadable. */
export function databaseTargetFromUrl(url: string | undefined): DatabaseTarget | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.hostname) return null;
    return { host: decodeURIComponent(u.hostname), port: u.port ? Number(u.port) : 5432 };
  } catch {
    return null;
  }
}

/** Network errors that mean "the database server cannot be reached" when they belong to the database connection. */
const NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"]);

/** Messages the pg driver and the server use for a lost, refused or restarting connection. */
const MESSAGES = [
  /connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /client has encountered a connection error/i,
  /server closed the connection unexpectedly/i,
  /terminating connection due to administrator command/i,
  /the database system is (starting up|shutting down|in recovery mode)/i,
];

/** SQLSTATE: 08xxx connection exception, 57P01..03 shutdown / cannot connect now, 53300 too many connections. */
function isUnavailableSqlState(code: string): boolean {
  return code.startsWith("08") || code === "57P01" || code === "57P02" || code === "57P03" || code === "53300";
}

function belongsToDatabase(e: Record<string, unknown>, target: DatabaseTarget | null): boolean {
  if (!target) return true; // unknown target (no URL or a unix socket): trust the error code
  if (typeof e.port === "number") return e.port === target.port;
  if (typeof e.hostname === "string") return e.hostname === target.host;
  return false;
}

function check(err: unknown, target: DatabaseTarget | null, depth: number): boolean {
  if (typeof err !== "object" || err === null || depth > 5) return false;
  const e = err as Record<string, unknown>;
  const code = typeof e.code === "string" ? e.code : "";
  if (code && isUnavailableSqlState(code)) return true;
  if (code && NETWORK_CODES.has(code) && belongsToDatabase(e, target)) return true;
  if (typeof e.message === "string" && MESSAGES.some((re) => re.test(e.message as string))) return true;
  if (check(e.cause, target, depth + 1)) return true;
  if (Array.isArray(e.errors)) return e.errors.some((inner) => check(inner, target, depth + 1));
  return false;
}

export function isDatabaseUnavailable(err: unknown, target: DatabaseTarget | null = null): boolean {
  return check(err, target, 0);
}

export const DATABASE_UNAVAILABLE_BODY = { error: "database unavailable", code: "database_unavailable" } as const;
export const RETRY_AFTER_SECONDS = 5;
const LOG_EVERY_MS = 10_000;

/**
 * Call it right after Fastify() is created, BEFORE any plugin is registered: a plugin context takes the error
 * handler of its parent when it is created, so one registered later would keep Fastify's default.
 */
export function registerDatabaseUnavailableHandler(app: FastifyInstance, databaseUrl?: string, nowMs: () => number = Date.now): void {
  const target = databaseTargetFromUrl(databaseUrl);
  let lastLogMs = 0;
  let suppressed = 0;
  app.setErrorHandler((err, request, reply) => {
    if (!isDatabaseUnavailable(err, target)) return reply.send(err);
    const now = nowMs();
    if (now - lastLogMs >= LOG_EVERY_MS) {
      app.log.warn({ err, url: request.url, suppressed }, "database unavailable — answering 503");
      lastLogMs = now;
      suppressed = 0;
    } else {
      suppressed += 1;
    }
    return reply.code(503).header("Retry-After", String(RETRY_AFTER_SECONDS)).send(DATABASE_UNAVAILABLE_BODY);
  });
}
