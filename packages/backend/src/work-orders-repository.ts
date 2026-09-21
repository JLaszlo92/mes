import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

export type WorkOrderStatus = "planned" | "released" | "in_progress" | "completed" | "cancelled";

export interface WorkOrder {
  id: string;
  orderNumber: string;
  partName: string;
  quantity: number;
  expectedCycleTimeSeconds: number | null;
  dueDate: string | null;
  status: WorkOrderStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

type WorkOrderRow = {
  id: string;
  order_number: string;
  part_name: string;
  quantity: number;
  expected_cycle_time_seconds: string | null;
  due_date: string | null;
  status: WorkOrderStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

function toWorkOrder(row: WorkOrderRow): WorkOrder {
  return {
    id: row.id,
    orderNumber: row.order_number,
    partName: row.part_name,
    quantity: row.quantity,
    expectedCycleTimeSeconds: row.expected_cycle_time_seconds ? Number(row.expected_cycle_time_seconds) : null,
    dueDate: row.due_date,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listWorkOrders(): Promise<WorkOrder[]> {
  const result = await pool.query<WorkOrderRow>(`SELECT * FROM work_orders ORDER BY created_at DESC`);
  return result.rows.map(toWorkOrder);
}

export async function getWorkOrder(id: string): Promise<WorkOrder | undefined> {
  const result = await pool.query<WorkOrderRow>(`SELECT * FROM work_orders WHERE id = $1`, [id]);
  return result.rows[0] ? toWorkOrder(result.rows[0]) : undefined;
}

export interface CreateWorkOrderInput {
  orderNumber: string;
  partName: string;
  quantity: number;
  expectedCycleTimeSeconds?: number;
  dueDate?: string;
  notes?: string;
}

export async function createWorkOrder(input: CreateWorkOrderInput): Promise<WorkOrder> {
  const result = await pool.query<WorkOrderRow>(
    `INSERT INTO work_orders (id, order_number, part_name, quantity, expected_cycle_time_seconds, due_date, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      randomUUID(),
      input.orderNumber,
      input.partName,
      input.quantity,
      input.expectedCycleTimeSeconds ?? null,
      input.dueDate ?? null,
      input.notes ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("INSERT ... RETURNING unexpectedly returned no row");
  return toWorkOrder(row);
}

export interface UpdateWorkOrderInput {
  partName?: string;
  quantity?: number;
  expectedCycleTimeSeconds?: number;
  dueDate?: string;
  status?: WorkOrderStatus;
  notes?: string;
}

export async function updateWorkOrder(id: string, input: UpdateWorkOrderInput): Promise<WorkOrder | undefined> {
  const result = await pool.query<WorkOrderRow>(
    `UPDATE work_orders SET
       part_name = COALESCE($2, part_name),
       quantity = COALESCE($3, quantity),
       expected_cycle_time_seconds = COALESCE($4, expected_cycle_time_seconds),
       due_date = COALESCE($5, due_date),
       status = COALESCE($6, status),
       notes = COALESCE($7, notes),
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      input.partName ?? null,
      input.quantity ?? null,
      input.expectedCycleTimeSeconds ?? null,
      input.dueDate ?? null,
      input.status ?? null,
      input.notes ?? null,
    ],
  );
  return result.rows[0] ? toWorkOrder(result.rows[0]) : undefined;
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}