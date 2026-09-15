import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

export interface Assignment {
  id: string;
  workOrderId: string;
  machineId: string;
  plannedStart: string;
  plannedEnd: string;
  orderNumber: string;
  partName: string;
  quantity: number;
  workOrderStatus: string;
  machineName: string;
}

type AssignmentRow = {
  id: string;
  work_order_id: string;
  machine_id: string;
  planned_start: string;
  planned_end: string;
  order_number: string;
  part_name: string;
  quantity: number;
  work_order_status: string;
  machine_name: string;
};


function toAssignment(row: AssignmentRow): Assignment {
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    machineId: row.machine_id,
    plannedStart: row.planned_start,
    plannedEnd: row.planned_end,
    orderNumber: row.order_number,
    partName: row.part_name,
    quantity: row.quantity,
    workOrderStatus: row.work_order_status,
    machineName: row.machine_name,
  };
}

const SELECT_JOINED = `
  SELECT
    woa.id, woa.work_order_id, woa.machine_id, woa.planned_start, woa.planned_end,
    wo.order_number, wo.part_name, wo.quantity, wo.status AS work_order_status,
    m.name AS machine_name
  FROM work_order_assignments woa
  JOIN work_orders wo ON wo.id = woa.work_order_id
  JOIN machines m ON m.id = woa.machine_id
`;

export async function listAssignments(): Promise<Assignment[]> {
  const result = await pool.query<AssignmentRow>(`${SELECT_JOINED} ORDER BY woa.planned_start`);
  return result.rows.map(toAssignment);
}

export async function listAssignmentsForMachine(machineId: string): Promise<Assignment[]> {
  const result = await pool.query<AssignmentRow>(
    `${SELECT_JOINED} WHERE woa.machine_id = $1 ORDER BY woa.planned_start`,
    [machineId],
  );
  return result.rows.map(toAssignment);
}

export interface CreateAssignmentInput {
  workOrderId: string;
  machineId: string;
  plannedStart: string;
  plannedEnd: string;
}

export async function createAssignment(input: CreateAssignmentInput): Promise<Assignment> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO work_order_assignments (id, work_order_id, machine_id, planned_start, planned_end)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [randomUUID(), input.workOrderId, input.machineId, input.plannedStart, input.plannedEnd],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error("INSERT ... RETURNING unexpectedly returned no row");

  const result = await pool.query<AssignmentRow>(`${SELECT_JOINED} WHERE woa.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw new Error("failed to load newly created assignment");
  return toAssignment(row);
}

export async function deleteAssignment(id: string): Promise<boolean> {
  const result = await pool.query(`DELETE FROM work_order_assignments WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23503";
}

export function isCheckViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23514";
}