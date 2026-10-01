import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

export interface Alert {
  id: string;
  /** Rendszerriasztásnál (pl. mentés) null. */
  ruleId: string | null;
  /** Rendszerriasztásnál (pl. mentés) null. */
  machineId: string | null;
  /** Rendszerriasztásnál "System". */
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
  rule_id: string | null;
  machine_id: string | null;
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

// LEFT JOIN: a rendszerriasztásokhoz nem tartozik gép (sql/031).
const SELECT_JOINED = `
  SELECT a.*, COALESCE(m.name, 'System') AS machine_name
  FROM alerts a
  LEFT JOIN machines m ON m.id = a.machine_id
`;

/**
 * Az összes még nyitott riasztás (korától függetlenül), plusz az elmúlt 24
 * óra lezárt riasztásai; a nyitottak elöl. Korábban csak a 24 órán belül
 * keletkezetteket adta vissza, így egy egy napnál régebben nyitott riasztás
 * — pl. egy tegnap óta álló gép — megoldatlanul eltűnt a listáról.
 */
export async function listAlerts(): Promise<Alert[]> {
  const result = await pool.query<AlertRow>(
    `${SELECT_JOINED}
     WHERE a.resolved_at IS NULL OR a.raised_at > now() - INTERVAL '24 hours'
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

// --- Rendszerriasztások (géphez és alert_rule-hoz nem kötött) -------------

/**
 * Nyit egy rendszerriasztást az adott típusra, vagy ha már van nyitott,
 * frissíti az üzenetét (pl. "failed" → "no backup for 26 h"). Egy típusból
 * egyszerre egy lehet nyitva — ezt a sql/031 egyedi indexe is kikényszeríti,
 * így két párhuzamos hívás sem nyithat duplikátumot. Visszatér: true, ha új
 * riasztás nyílt.
 */
export async function raiseOrUpdateSystemAlert(type: string, message: string): Promise<boolean> {
  const updated = await pool.query(
    `UPDATE alerts SET message = $2
     WHERE type = $1 AND machine_id IS NULL AND resolved_at IS NULL AND message IS DISTINCT FROM $2`,
    [type, message],
  );
  if ((updated.rowCount ?? 0) > 0) return false;

  const inserted = await pool.query(
    `INSERT INTO alerts (id, rule_id, machine_id, type, message)
     VALUES ($1, NULL, NULL, $2, $3)
     ON CONFLICT (type) WHERE resolved_at IS NULL AND machine_id IS NULL DO NOTHING`,
    [randomUUID(), type, message],
  );
  return (inserted.rowCount ?? 0) > 0;
}

/** Lezárja az adott típus nyitott rendszerriasztását. Visszatér: true, ha volt mit lezárni. */
export async function resolveSystemAlert(type: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE alerts SET resolved_at = now() WHERE type = $1 AND machine_id IS NULL AND resolved_at IS NULL`,
    [type],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function acknowledgeAlert(id: string, userId: string): Promise<Alert | undefined> {
  await pool.query(`UPDATE alerts SET acknowledged_by = $2, acknowledged_at = now() WHERE id = $1`, [id, userId]);
  const result = await pool.query<AlertRow>(`${SELECT_JOINED} WHERE a.id = $1`, [id]);
  return result.rows[0] ? toAlert(result.rows[0]) : undefined;
}

export interface AlertHistoryFilter {
  status: "open" | "resolved" | "all";
  machineIds?: string[];
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

/**
 * Lapozott riasztás-előzmény (a 24 órás /api/alerts listán túl). A
 * rendszerriasztások (machine_id NULL) gép-szűrésnél is benne maradnak.
 */
export async function listAlertHistory(f: AlertHistoryFilter): Promise<{ rows: Alert[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (sql: (n: number) => string, value: unknown) => {
    params.push(value);
    conditions.push(sql(params.length));
  };
  if (f.status === "open") conditions.push("a.resolved_at IS NULL");
  if (f.status === "resolved") conditions.push("a.resolved_at IS NOT NULL");
  if (f.machineIds) add((n) => `(a.machine_id IS NULL OR a.machine_id = ANY($${n}::text[]))`, f.machineIds);
  if (f.from) add((n) => `a.raised_at >= $${n}`, f.from);
  if (f.to) add((n) => `a.raised_at <= $${n}`, f.to);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = await pool.query<{ count: string }>(`SELECT count(*) FROM alerts a ${where}`, params);
  const rows = await pool.query<AlertRow>(
    `${SELECT_JOINED} ${where} ORDER BY a.raised_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, f.limit, f.offset],
  );
  return { rows: rows.rows.map(toAlert), total: Number(total.rows[0]?.count ?? 0) };
}
