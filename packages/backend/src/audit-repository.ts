import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

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
 */
export async function recordAuditEvent(event: AuditEventInput): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_log (id, actor_id, actor_email, action, target, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
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

export async function listAuditLog(limit = 200): Promise<AuditEntry[]> {
  const result = await pool.query<AuditRow>(`SELECT * FROM audit_log ORDER BY occurred_at DESC LIMIT $1`, [
    limit,
  ]);
  return result.rows.map(toAuditEntry);
}