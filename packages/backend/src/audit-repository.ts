import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
import { likePattern, likePrefix } from "./paging.js";

export interface AuditEventInput {
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  target?: string | null;
  details?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

/**
 * Fire-and-forget insert (PRD 8.8): audit logging must never block or fail
 * the action it's recording. A write failure here is logged to the
 * console, never thrown — losing an audit row is bad, but blocking a
 * login or a machine update because the audit table had a hiccup would
 * be worse.
 *
 * Ha csak actorId érkezik, az actor_email-t ugyanebben az INSERT-ben a
 * users táblából tölti ki (egy lekérdezés, extra adatbázis-kör nélkül). Az
 * e-mail pillanatképként tárolódik: az actor_id FK-ja ON DELETE SET NULL,
 * így egy később törölt felhasználó bejegyzéseiről is kiderül, ki volt az.
 * Kifejezetten átadott actorEmail (pl. login_failed egy nem létező
 * fiókra) elsőbbséget élvez.
 */
export async function recordAuditEvent(event: AuditEventInput): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_log (id, actor_id, actor_email, action, target, details, ip_address)
       VALUES ($1, $2::text, COALESCE($3::text, (SELECT email FROM users WHERE id = $2::text)), $4, $5, $6, $7)`,
      [
        randomUUID(),
        event.actorId ?? null,
        event.actorEmail ?? null,
        event.action,
        event.target ?? null,
        event.details ? JSON.stringify(event.details) : null,
        event.ipAddress ?? null,
      ],
    );
  } catch (err) {
    console.error("failed to write audit log entry", err);
  }
}

export interface AuditEntry {
  id: string;
  occurredAt: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
}

type AuditRow = {
  id: string;
  occurred_at: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
};

function toAuditEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actorId: row.actor_id,
    actorEmail: row.actor_email,
    action: row.action,
    target: row.target,
    details: row.details,
    ipAddress: row.ip_address,
  };
}

export interface ListAuditLogOptions {
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLogPage {
  entries: AuditEntry[];
  total: number;
}

export interface AuditLogFilter {
  from?: string;
  to?: string;
  /** Pontos művelet, vagy "prefix*" (pl. "work_order_*"). */
  action?: string;
  /** Részlet a végrehajtó e-mail-címéből. */
  actor?: string;
  /** Pontos cél-azonosító (gép, rendelés, felhasználó…). */
  target?: string;
  /** Szabad szöveg a műveletben, célban, végrehajtóban és a részletekben. */
  q?: string;
  limit?: number;
  offset?: number;
}

export async function listAuditLog(options: AuditLogFilter = {}): Promise<AuditLogPage> {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (sql: (n: number) => string, value: unknown) => {
    params.push(value);
    conditions.push(sql(params.length));
  };
  if (options.from) add((n) => `occurred_at >= $${n}`, options.from);
  if (options.to) add((n) => `occurred_at <= $${n}`, options.to);
  if (options.action) {
    if (options.action.endsWith("*")) add((n) => `action LIKE $${n}`, likePrefix(options.action.slice(0, -1)));
    else add((n) => `action = $${n}`, options.action);
  }
  if (options.actor) add((n) => `actor_email ILIKE $${n}`, likePattern(options.actor));
  if (options.target) add((n) => `target = $${n}`, options.target);
  if (options.q) {
    add(
      (n) => `(action ILIKE $${n} OR target ILIKE $${n} OR actor_email ILIKE $${n} OR details::text ILIKE $${n} OR ip_address ILIKE $${n})`,
      likePattern(options.q),
    );
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const countResult = await pool.query<{ count: string }>(`SELECT COUNT(*) FROM audit_log ${whereClause}`, params);
  const result = await pool.query<AuditRow>(
    `SELECT * FROM audit_log ${whereClause} ORDER BY occurred_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return {
    entries: result.rows.map(toAuditEntry),
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

/** A naplóban előforduló műveletek — a szűrő legördülőjéhez. */
export async function listAuditActions(): Promise<{ action: string; count: number }[]> {
  const result = await pool.query<{ action: string; count: string }>(
    `SELECT action, count(*) AS count FROM audit_log GROUP BY action ORDER BY action`,
  );
  return result.rows.map((r) => ({ action: r.action, count: Number(r.count) }));
}
