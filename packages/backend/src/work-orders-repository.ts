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

export interface WorkOrderProgress {
  workOrderId: string;
  machineId: string | null;
  machineName: string | null;
  operatorEmail: string | null;
  startedAt: string | null;
  goodCount: number;
  scrapCount: number;
  targetReached: boolean;
}

/**
 * Ugyanazt a trükköt használja, mint a Lots (tétel-genealógia): a gépet a
 * work_order_assignments-ből, a kezdés időpontját és az operátort az
 * audit logból (amikor "in_progress"-re váltott). Ha countOverproduction
 * === false és a célmennyiség már elérve, a számlálás a célmennyiséget
 * elérő N-edik jó darab időbélyegénél áll meg — az utána termelt darabok
 * nem számítanak bele ebbe a munkarendelésbe.
 */
export async function computeWorkOrderProgress(
  workOrderId: string,
  quantity: number,
  countOverproduction: boolean,
): Promise<WorkOrderProgress> {
  const assignmentResult = await pool.query<{ machine_id: string; machine_name: string }>(
    `SELECT woa.machine_id, m.name AS machine_name
     FROM work_order_assignments woa
     JOIN machines m ON m.id = woa.machine_id
     WHERE woa.work_order_id = $1 ORDER BY woa.planned_start LIMIT 1`,
    [workOrderId],
  );
  const machineId = assignmentResult.rows[0]?.machine_id ?? null;
  const machineName = assignmentResult.rows[0]?.machine_name ?? null;

  const startResult = await pool.query<{ actor_email: string | null; occurred_at: string }>(
    `SELECT u.email AS actor_email, al.occurred_at
     FROM audit_log al
     LEFT JOIN users u ON u.id = al.actor_id
     WHERE al.action = 'work_order_updated' AND al.target = $1 AND al.details->>'status' = 'in_progress'
     ORDER BY al.occurred_at ASC LIMIT 1`,
    [workOrderId],
  );
  const startedAt = startResult.rows[0]?.occurred_at ?? null;
  const operatorEmail = startResult.rows[0]?.actor_email ?? null;

  if (!machineId || !startedAt) {
    return { workOrderId, machineId, machineName, operatorEmail, startedAt, goodCount: 0, scrapCount: 0, targetReached: false };
  }

  let cappedAtTimestamp: string | null = null;
  if (!countOverproduction && quantity > 0) {
    const nthGoodResult = await pool.query<{ timestamp: string }>(
      `SELECT "timestamp" FROM events
       WHERE type = 'production_count' AND machine_id = $1 AND payload->>'result' = 'good' AND "timestamp" >= $2
       ORDER BY "timestamp" ASC
       OFFSET $3 LIMIT 1`,
      [machineId, startedAt, quantity - 1],
    );
    cappedAtTimestamp = nthGoodResult.rows[0]?.timestamp ?? null;
  }

  const countsResult = await pool.query<{ good_count: string; scrap_count: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE payload->>'result' = 'good') AS good_count,
       COUNT(*) FILTER (WHERE payload->>'result' = 'scrap') AS scrap_count
     FROM events
     WHERE type = 'production_count' AND machine_id = $1
       AND "timestamp" BETWEEN $2 AND COALESCE($3::timestamptz, now())`,
    [machineId, startedAt, cappedAtTimestamp],
  );
  const goodCount = Number(countsResult.rows[0]?.good_count ?? 0);
  const scrapCount = Number(countsResult.rows[0]?.scrap_count ?? 0);

  return {
    workOrderId,
    machineId,
    machineName,
    operatorEmail,
    startedAt,
    goodCount,
    scrapCount,
    targetReached: goodCount >= quantity,
  };
}

export async function getWorkOrderProgress(
  workOrderId: string,
): Promise<(WorkOrderProgress & { quantity: number; remaining: number }) | undefined> {
  const woResult = await pool.query<{ quantity: number; count_overproduction: boolean }>(
    `SELECT quantity, count_overproduction FROM work_orders WHERE id = $1`,
    [workOrderId],
  );
  const wo = woResult.rows[0];
  if (!wo) return undefined;
  const progress = await computeWorkOrderProgress(workOrderId, wo.quantity, wo.count_overproduction);
  return { ...progress, quantity: wo.quantity, remaining: Math.max(0, wo.quantity - progress.goodCount) };
}