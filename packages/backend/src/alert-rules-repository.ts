import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

export type AlertType = "machine_down" | "scrap_rate";

export interface AlertRule {
  id: string;
  type: AlertType;
  machineId: string | null;
  threshold: number;
  notifyRoles: string[];
  isActive: boolean;
  createdAt: string;
}

type AlertRuleRow = {
  id: string;
  type: AlertType;
  machine_id: string | null;
  threshold: string;
  notify_roles: string[];
  is_active: boolean;
  created_at: string;
};

function toAlertRule(row: AlertRuleRow): AlertRule {
  return {
    id: row.id,
    type: row.type,
    machineId: row.machine_id,
    threshold: Number(row.threshold),
    notifyRoles: row.notify_roles,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

export async function listAlertRules(): Promise<AlertRule[]> {
  const result = await pool.query<AlertRuleRow>(`SELECT * FROM alert_rules ORDER BY created_at DESC`);
  return result.rows.map(toAlertRule);
}

export interface CreateAlertRuleInput {
  type: AlertType;
  machineId?: string;
  threshold: number;
  notifyRoles?: string[];
}

export async function createAlertRule(input: CreateAlertRuleInput): Promise<AlertRule> {
  const result = await pool.query<AlertRuleRow>(
    `INSERT INTO alert_rules (id, type, machine_id, threshold, notify_roles)
     VALUES ($1, $2, $3, $4, COALESCE($5::text[], '{supervisor,manager}'::text[]))
     RETURNING *`,
    [randomUUID(), input.type, input.machineId ?? null, input.threshold, input.notifyRoles ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error("INSERT ... RETURNING unexpectedly returned no row");
  return toAlertRule(row);
}

export interface UpdateAlertRuleInput {
  threshold?: number;
  notifyRoles?: string[];
  isActive?: boolean;
}

export async function updateAlertRule(id: string, input: UpdateAlertRuleInput): Promise<AlertRule | undefined> {
  const result = await pool.query<AlertRuleRow>(
    `UPDATE alert_rules SET
       threshold = COALESCE($2, threshold),
       notify_roles = COALESCE($3::text[], notify_roles),
       is_active = COALESCE($4, is_active)
     WHERE id = $1
     RETURNING *`,
    [id, input.threshold ?? null, input.notifyRoles ?? null, input.isActive ?? null],
  );
  return result.rows[0] ? toAlertRule(result.rows[0]) : undefined;
}

export async function deleteAlertRule(id: string): Promise<boolean> {
  const result = await pool.query(`DELETE FROM alert_rules WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}