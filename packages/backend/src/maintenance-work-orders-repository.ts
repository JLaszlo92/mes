import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

export type MaintenanceStatus = "open" | "assigned" | "in_progress" | "closed";

export interface MaintenancePart {
  id: string;
  partName: string;
  quantity: number;
  loggedAt: string;
}

export interface MaintenanceLabor {
  id: string;
  performedByEmail: string | null;
  hours: number;
  notes: string | null;
  loggedAt: string;
}

export interface MaintenanceWorkOrder {
  id: string;
  machineId: string;
  machineName: string;
  title: string;
  description: string | null;
  status: MaintenanceStatus;
  assignedToEmail: string | null;
  createdByEmail: string | null;
  sourceType: string | null;
  sourceId: string | null;
  createdAt: string;
  closedAt: string | null;
}

type MwoRow = {
  id: string;
  machine_id: string;
  machine_name: string;
  title: string;
  description: string | null;
  status: MaintenanceStatus;
  assigned_to_email: string | null;
  created_by_email: string | null;
  source_type: string | null;
  source_id: string | null;
  created_at: string;
  closed_at: string | null;
};

function toMwo(row: MwoRow): MaintenanceWorkOrder {
  return {
    id: row.id,
    machineId: row.machine_id,
    machineName: row.machine_name,
    title: row.title,
    description: row.description,
    status: row.status,
    assignedToEmail: row.assigned_to_email,
    createdByEmail: row.created_by_email,
    sourceType: row.source_type,
    sourceId: row.source_id,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

const SELECT_JOINED = `
  SELECT
    mwo.*,
    m.name AS machine_name,
    assignee.email AS assigned_to_email,
    creator.email AS created_by_email
  FROM maintenance_work_orders mwo
  JOIN machines m ON m.id = mwo.machine_id
  LEFT JOIN users assignee ON assignee.id = mwo.assigned_to
  LEFT JOIN users creator ON creator.id = mwo.created_by
`;

export async function listMaintenanceWorkOrders(): Promise<MaintenanceWorkOrder[]> {
  const result = await pool.query<MwoRow>(`${SELECT_JOINED} ORDER BY mwo.status = 'closed', mwo.created_at DESC`);
  return result.rows.map(toMwo);
}

export async function getMaintenanceWorkOrder(id: string): Promise<MaintenanceWorkOrder | undefined> {
  const result = await pool.query<MwoRow>(`${SELECT_JOINED} WHERE mwo.id = $1`, [id]);
  return result.rows[0] ? toMwo(result.rows[0]) : undefined;
}

export interface CreateMwoInput {
  machineId: string;
  title: string;
  description?: string;
  sourceType?: string;
  sourceId?: string;
  createdBy: string;
}

export async function createMaintenanceWorkOrder(input: CreateMwoInput): Promise<MaintenanceWorkOrder> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO maintenance_work_orders (id, machine_id, title, description, source_type, source_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      randomUUID(),
      input.machineId,
      input.title,
      input.description ?? null,
      input.sourceType ?? null,
      input.sourceId ?? null,
      input.createdBy,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error("INSERT ... RETURNING unexpectedly returned no row");
  const result = await pool.query<MwoRow>(`${SELECT_JOINED} WHERE mwo.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw new Error("failed to load newly created maintenance work order");
  return toMwo(row);
}

export interface UpdateMwoInput {
  status?: MaintenanceStatus;
  assignedTo?: string;
}

export async function updateMaintenanceWorkOrder(
  id: string,
  input: UpdateMwoInput,
): Promise<MaintenanceWorkOrder | undefined> {
  const closedAtClause = input.status === "closed" ? `closed_at = now()` : `closed_at = closed_at`;
  await pool.query(
    `UPDATE maintenance_work_orders SET
       status = COALESCE($2, status),
       assigned_to = COALESCE($3, assigned_to),
       ${closedAtClause}
     WHERE id = $1`,
    [id, input.status ?? null, input.assignedTo ?? null],
  );
  return getMaintenanceWorkOrder(id);
}

export async function listParts(workOrderId: string): Promise<MaintenancePart[]> {
  const result = await pool.query<{ id: string; part_name: string; quantity: number; logged_at: string }>(
    `SELECT * FROM maintenance_work_order_parts WHERE work_order_id = $1 ORDER BY logged_at`,
    [workOrderId],
  );
  return result.rows.map((r) => ({ id: r.id, partName: r.part_name, quantity: r.quantity, loggedAt: r.logged_at }));
}

export async function addPart(workOrderId: string, partName: string, quantity: number): Promise<void> {
  await pool.query(
    `INSERT INTO maintenance_work_order_parts (id, work_order_id, part_name, quantity) VALUES ($1, $2, $3, $4)`,
    [randomUUID(), workOrderId, partName, quantity],
  );
}

export async function listLabor(workOrderId: string): Promise<MaintenanceLabor[]> {
  const result = await pool.query<{
    id: string;
    performed_by_email: string | null;
    hours: string;
    notes: string | null;
    logged_at: string;
  }>(
    `SELECT l.id, u.email AS performed_by_email, l.hours, l.notes, l.logged_at
     FROM maintenance_work_order_labor l
     LEFT JOIN users u ON u.id = l.performed_by
     WHERE l.work_order_id = $1 ORDER BY l.logged_at`,
    [workOrderId],
  );
  return result.rows.map((r) => ({
    id: r.id,
    performedByEmail: r.performed_by_email,
    hours: Number(r.hours),
    notes: r.notes,
    loggedAt: r.logged_at,
  }));
}

export async function addLabor(
  workOrderId: string,
  performedBy: string,
  hours: number,
  notes?: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO maintenance_work_order_labor (id, work_order_id, performed_by, hours, notes) VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), workOrderId, performedBy, hours, notes ?? null],
  );
}

export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23503";
}