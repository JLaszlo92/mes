import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

export interface Alert {
  id: string;
  ruleId: string;
  machineId: string;
  machineName: string;
  type: string;
  message: string;
  raisedAt: string;
  resolvedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
}

type AlertRow = {
  id: string;
  rule_id: string;
  machine_id: string;
  machine_name: string;
  type: string;
  message: string;
  raised_at: string;
  resolved_at: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
};

function toAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    ruleId: row.rule_id,
    machineId: row.machine_id,
    machineName: row.machine_name,
    type: row.type,
    message: row.message,
    raisedAt: row.raised_at,
    resolvedAt: row.resolved_at,
    acknowledgedBy: row.acknowledged_by,
    acknowledgedAt: row.acknowledged_at,
  };
}

const SELECT_JOINED = `
  SELECT a.*, m.name AS machine_name
  FROM alerts a
  JOIN machines m ON m.id = a.machine_id
`;

/** Az elmúlt 24 óra összes riasztása, a még nyitottak elöl. */
export async function listAlerts(): Promise<Alert[]> {
  const result = await pool.query<AlertRow>(
    `${SELECT_JOINED}
     WHERE a.raised_at > now() - INTERVAL '24 hours'
     ORDER BY a.resolved_at IS NOT NULL, a.raised_at DESC`,
  );
  return result.rows.map(toAlert);
}

export async function findOpenAlert(ruleId: string, machineId: string): Promise<{ id: string } | undefined> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM alerts WHERE rule_id = $1 AND machine_id = $2 AND resolved_at IS NULL`,
    [ruleId, machineId],
  );
  return result.rows[0];
}

export async function raiseAlert(ruleId: string, machineId: string, type: string, message: string): Promise<void> {
  await pool.query(`INSERT INTO alerts (id, rule_id, machine_id, type, message) VALUES ($1, $2, $3, $4, $5)`, [
    randomUUID(),
    ruleId,
    machineId,
    type,
    message,
  ]);
}

export async function resolveOpenAlert(ruleId: string, machineId: string): Promise<void> {
  await pool.query(`UPDATE alerts SET resolved_at = now() WHERE rule_id = $1 AND machine_id = $2 AND resolved_at IS NULL`, [
    ruleId,
    machineId,
  ]);
}

export async function acknowledgeAlert(id: string, userId: string): Promise<Alert | undefined> {
  await pool.query(`UPDATE alerts SET acknowledged_by = $2, acknowledged_at = now() WHERE id = $1`, [id, userId]);
  const result = await pool.query<AlertRow>(`${SELECT_JOINED} WHERE a.id = $1`, [id]);
  return result.rows[0] ? toAlert(result.rows[0]) : undefined;
}