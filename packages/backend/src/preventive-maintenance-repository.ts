import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

export type TriggerType = "calendar" | "usage_hours" | "part_count";

export interface PreventiveSchedule {
  id: string;
  machineId: string;
  machineName: string;
  triggerType: TriggerType;
  intervalValue: number;
  description: string;
  lastTriggeredAt: string | null;
  createdAt: string;
  isActive: boolean;
}

type ScheduleRow = {
  id: string;
  machine_id: string;
  machine_name: string;
  trigger_type: TriggerType;
  interval_value: string;
  description: string;
  last_triggered_at: string | null;
  created_at: string;
  is_active: boolean;
};

function toSchedule(row: ScheduleRow): PreventiveSchedule {
  return {
    id: row.id,
    machineId: row.machine_id,
    machineName: row.machine_name,
    triggerType: row.trigger_type,
    intervalValue: Number(row.interval_value),
    description: row.description,
    lastTriggeredAt: row.last_triggered_at,
    createdAt: row.created_at,
    isActive: row.is_active,
  };
}

const SELECT_JOINED = `
  SELECT pms.*, m.name AS machine_name
  FROM preventive_maintenance_schedules pms
  JOIN machines m ON m.id = pms.machine_id
`;

export async function listSchedules(): Promise<PreventiveSchedule[]> {
  const result = await pool.query<ScheduleRow>(`${SELECT_JOINED} ORDER BY m.name, pms.trigger_type`);
  return result.rows.map(toSchedule);
}

export async function listActiveSchedules(): Promise<PreventiveSchedule[]> {
  const result = await pool.query<ScheduleRow>(`${SELECT_JOINED} WHERE pms.is_active`);
  return result.rows.map(toSchedule);
}

export interface CreateScheduleInput {
  machineId: string;
  triggerType: TriggerType;
  intervalValue: number;
  description: string;
}

export async function createSchedule(input: CreateScheduleInput): Promise<PreventiveSchedule> {
  const result = await pool.query<ScheduleRow>(
    `WITH inserted AS (
       INSERT INTO preventive_maintenance_schedules (id, machine_id, trigger_type, interval_value, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *
     )
     SELECT inserted.*, m.name AS machine_name FROM inserted JOIN machines m ON m.id = inserted.machine_id`,
    [randomUUID(), input.machineId, input.triggerType, input.intervalValue, input.description],
  );
  const row = result.rows[0];
  if (!row) throw new Error("INSERT ... RETURNING unexpectedly returned no row");
  return toSchedule(row);
}

export async function deactivateSchedule(id: string): Promise<boolean> {
  const result = await pool.query(`UPDATE preventive_maintenance_schedules SET is_active = false WHERE id = $1`, [
    id,
  ]);
  return (result.rowCount ?? 0) > 0;
}

export async function resetSchedule(id: string): Promise<void> {
  await pool.query(`UPDATE preventive_maintenance_schedules SET last_triggered_at = now() WHERE id = $1`, [id]);
}

export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23503";
}