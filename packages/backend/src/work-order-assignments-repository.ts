import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./db.js";
import type { TimeRange } from "./work-order-scheduling.js";

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

const INSERT_ASSIGNMENT = `
  INSERT INTO work_order_assignments (id, work_order_id, machine_id, planned_start, planned_end)
  VALUES ($1, $2, $3, $4, $5)
  RETURNING id
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
  const inserted = await pool.query<{ id: string }>(INSERT_ASSIGNMENT, [
    randomUUID(),
    input.workOrderId,
    input.machineId,
    input.plannedStart,
    input.plannedEnd,
  ]);
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

export interface UpdateAssignmentInput {
  machineId?: string;
  plannedStart?: string;
  plannedEnd?: string;
}

export async function updateAssignment(id: string, input: UpdateAssignmentInput): Promise<Assignment | undefined> {
  await pool.query(
    `UPDATE work_order_assignments SET
       machine_id = COALESCE($2, machine_id),
       planned_start = COALESCE($3, planned_start),
       planned_end = COALESCE($4, planned_end)
     WHERE id = $1`,
    [id, input.machineId ?? null, input.plannedStart ?? null, input.plannedEnd ?? null],
  );
  const result = await pool.query<AssignmentRow>(`${SELECT_JOINED} WHERE woa.id = $1`, [id]);
  return result.rows[0] ? toAssignment(result.rows[0]) : undefined;
}

// --- Teljes munkarendelés (át)ütemezése, atomikusan ---------------------

/** Üzleti szabályba ütköző ütemezési kérés — a route 409-cel válaszol rá. */
export class ScheduleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleConflictError";
  }
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A munkarendelés sorát zárolja (FOR UPDATE), így két egyidejű átütemezés
 * ugyanarra a rendelésre sorban fut le, nem keveredik össze a szegmensük.
 */
async function lockWorkOrderStatus(client: PoolClient, workOrderId: string): Promise<string | undefined> {
  const result = await client.query<{ status: string }>(
    `SELECT status FROM work_orders WHERE id = $1 FOR UPDATE`,
    [workOrderId],
  );
  return result.rows[0]?.status;
}

async function loadAssignmentsForWorkOrder(client: PoolClient, workOrderId: string): Promise<Assignment[]> {
  const result = await client.query<AssignmentRow>(
    `${SELECT_JOINED} WHERE woa.work_order_id = $1 ORDER BY woa.planned_start`,
    [workOrderId],
  );
  return result.rows.map(toAssignment);
}

export interface ScheduleChange {
  previous: Assignment[];
  current: Assignment[];
}

/**
 * A munkarendelés összes meglévő szegmensét lecseréli a megadottakra, egy
 * tranzakcióban. `undefined`, ha a munkarendelés nem létezik.
 *
 * Szabályok:
 *  - completed / cancelled rendelés nem ütemezhető át;
 *  - in_progress rendelés időben mozgatható, de másik gépre nem — a
 *    `computeWorkOrderProgress` az első hozzárendelés gépéről számolja a
 *    darabszámot, így a gépcsere csendben elrontaná a folyamatban lévő
 *    rendelés számlálását.
 */
export async function replaceScheduleForWorkOrder(
  workOrderId: string,
  machineId: string,
  chunks: TimeRange[],
): Promise<ScheduleChange | undefined> {
  if (chunks.length === 0) throw new Error("replaceScheduleForWorkOrder requires at least one chunk");

  return withTransaction(async (client) => {
    const status = await lockWorkOrderStatus(client, workOrderId);
    if (!status) return undefined;
    if (status === "completed" || status === "cancelled") {
      throw new ScheduleConflictError(`work order is ${status} and can no longer be rescheduled`);
    }

    const previous = await loadAssignmentsForWorkOrder(client, workOrderId);
    if (status === "in_progress" && previous.some((a) => a.machineId !== machineId)) {
      throw new ScheduleConflictError(
        "an in-progress work order cannot be moved to another machine — its production counts come from the assigned machine",
      );
    }

    await client.query(`DELETE FROM work_order_assignments WHERE work_order_id = $1`, [workOrderId]);
    for (const chunk of chunks) {
      await client.query(INSERT_ASSIGNMENT, [
        randomUUID(),
        workOrderId,
        machineId,
        chunk.start.toISOString(),
        chunk.end.toISOString(),
      ]);
    }

    const current = await loadAssignmentsForWorkOrder(client, workOrderId);
    return { previous, current };
  });
}

/**
 * A munkarendelés összes szegmensének törlése, egy tranzakcióban. Csak
 * planned / released rendelésnél engedett — egy elindított rendelésről a
 * gép-hozzárendelés levétele a darabszám-követést szakítaná meg.
 * `undefined`, ha a munkarendelés nem létezik; egyébként a törölt szegmensek.
 */
export async function clearScheduleForWorkOrder(workOrderId: string): Promise<Assignment[] | undefined> {
  return withTransaction(async (client) => {
    const status = await lockWorkOrderStatus(client, workOrderId);
    if (!status) return undefined;
    if (status !== "planned" && status !== "released") {
      throw new ScheduleConflictError(
        `work order is ${status.replace("_", " ")} — only planned or released orders can be unscheduled`,
      );
    }
    const previous = await loadAssignmentsForWorkOrder(client, workOrderId);
    await client.query(`DELETE FROM work_order_assignments WHERE work_order_id = $1`, [workOrderId]);
    return previous;
  });
}
