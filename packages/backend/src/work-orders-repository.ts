import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./db.js";
import { BULK_ELIGIBLE, type WorkOrderBulk, type WorkOrderPatch } from "./work-order-input.js";

export type WorkOrderStatus = "planned" | "released" | "in_progress" | "completed" | "cancelled";
export type CompletionMode = "manual" | "auto";

export interface WorkOrder {
  id: string;
  orderNumber: string;
  partName: string;
  quantity: number;
  expectedCycleTimeSeconds: number | null;
  dueDate: string | null;
  status: WorkOrderStatus;
  notes: string | null;
  completionMode: CompletionMode;
  countOverproduction: boolean;
  createdAt: string;
  updatedAt: string;
  /** Kiválasztott munkautasítás neve; null = automatikus (az alkatrész nevével egyező). */
  workInstructionName: string | null;
  /** A rendeléshez rögzített alapanyag-tételek (work_order_material_consumption). */
  materials: WorkOrderMaterial[];
  /** Az ütemezés összefoglalója (work_order_assignments), vagy null, ha nincs ütemezve. */
  schedule: WorkOrderScheduleSummary | null;
}

export interface WorkOrderMaterial {
  materialLotId: string;
  materialName: string;
  lotNumber: string;
}

export interface WorkOrderScheduleSummary {
  machineId: string;
  machineName: string;
  plannedStart: string;
  plannedEnd: string;
  /** A szegmensek összhossza — munkaidő, a műszakon kívüli rések nélkül. */
  plannedSeconds: number;
  segments: number;
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
  completion_mode: CompletionMode;
  count_overproduction: boolean;
  created_at: string;
  updated_at: string;
  work_instruction_name?: string | null;
  materials?: WorkOrderMaterial[] | null;
  sched_machine_id?: string | null;
  sched_machine_name?: string | null;
  sched_start?: string | null;
  sched_end?: string | null;
  sched_seconds?: string | null;
  sched_segments?: string | null;
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
    completionMode: row.completion_mode,
    countOverproduction: row.count_overproduction,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    workInstructionName: row.work_instruction_name ?? null,
    materials: row.materials ?? [],
    schedule:
      row.sched_machine_id && row.sched_start && row.sched_end
        ? {
            machineId: row.sched_machine_id,
            machineName: row.sched_machine_name ?? row.sched_machine_id,
            plannedStart: row.sched_start,
            plannedEnd: row.sched_end,
            plannedSeconds: Number(row.sched_seconds ?? 0),
            segments: Number(row.sched_segments ?? 0),
          }
        : null,
  };
}

// Egy rendelés ütemezése a work_order_assignments szegmenseiből: a gép az
// első szegmensé (ugyanaz a szabály, mint a computeWorkOrderProgress-ben).
const SELECT_WITH_SCHEDULE = `
  SELECT wo.*,
         s.machine_id AS sched_machine_id, s.machine_name AS sched_machine_name,
         s.planned_start AS sched_start, s.planned_end AS sched_end,
         s.planned_seconds AS sched_seconds, s.segments AS sched_segments,
         mat.materials
  FROM work_orders wo
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object('materialLotId', ml.id, 'materialName', ml.material_name, 'lotNumber', ml.lot_number)
                    ORDER BY c.recorded_at, ml.id) AS materials
    FROM work_order_material_consumption c
    JOIN material_lots ml ON ml.id = c.material_lot_id
    WHERE c.work_order_id = wo.id
  ) mat ON true
  LEFT JOIN LATERAL (
    SELECT (array_agg(woa.machine_id ORDER BY woa.planned_start))[1] AS machine_id,
           (array_agg(m.name ORDER BY woa.planned_start))[1] AS machine_name,
           min(woa.planned_start) AS planned_start,
           max(woa.planned_end) AS planned_end,
           sum(EXTRACT(EPOCH FROM woa.planned_end - woa.planned_start)) AS planned_seconds,
           count(*) AS segments
    FROM work_order_assignments woa
    JOIN machines m ON m.id = woa.machine_id
    WHERE woa.work_order_id = wo.id
  ) s ON s.segments > 0`;

export async function listWorkOrders(): Promise<WorkOrder[]> {
  const result = await pool.query<WorkOrderRow>(`${SELECT_WITH_SCHEDULE} ORDER BY wo.created_at DESC`);
  return result.rows.map(toWorkOrder);
}

export async function getWorkOrder(id: string, db: Pick<PoolClient, "query"> = pool): Promise<WorkOrder | undefined> {
  const result = await db.query<WorkOrderRow>(`${SELECT_WITH_SCHEDULE} WHERE wo.id = $1`, [id]);
  return result.rows[0] ? toWorkOrder(result.rows[0]) : undefined;
}

export interface CreateWorkOrderInput {
  orderNumber: string;
  partName: string;
  quantity: number;
  expectedCycleTimeSeconds?: number | null;
  dueDate?: string | null;
  notes?: string | null;
  status?: WorkOrderStatus;
  completionMode?: CompletionMode;
  countOverproduction?: boolean;
  workInstructionName?: string | null;
}

export async function createWorkOrder(input: CreateWorkOrderInput): Promise<WorkOrder> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO work_orders (id, order_number, part_name, quantity, expected_cycle_time_seconds, due_date, notes, completion_mode, count_overproduction, status, work_instruction_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'manual'), COALESCE($9, true), COALESCE($10, 'planned'), $11)`,
    [
      id,
      input.orderNumber,
      input.partName,
      input.quantity,
      input.expectedCycleTimeSeconds ?? null,
      input.dueDate ?? null,
      input.notes ?? null,
      input.completionMode ?? null,
      input.countOverproduction ?? null,
      input.status ?? null,
      input.workInstructionName ?? null,
    ],
  );
  const created = await getWorkOrder(id);
  if (!created) throw new Error("INSERT succeeded but the work order could not be read back");
  return created;
}

export interface UpdateWorkOrderInput {
  partName?: string;
  quantity?: number;
  expectedCycleTimeSeconds?: number;
  dueDate?: string;
  status?: WorkOrderStatus;
  notes?: string;
  completionMode?: CompletionMode;
  countOverproduction?: boolean;
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
       completion_mode = COALESCE($8, completion_mode),
       count_overproduction = COALESCE($9, count_overproduction),
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
      input.completionMode ?? null,
      input.countOverproduction ?? null,
    ],
  );
  return result.rows[0] ? toWorkOrder(result.rows[0]) : undefined;
}

const COLUMN_BY_FIELD: Record<keyof WorkOrderPatch, string> = {
  partName: "part_name",
  quantity: "quantity",
  expectedCycleTimeSeconds: "expected_cycle_time_seconds",
  dueDate: "due_date",
  status: "status",
  notes: "notes",
  completionMode: "completion_mode",
  countOverproduction: "count_overproduction",
  workInstructionName: "work_instruction_name",
};

export interface WorkOrderChange {
  previous: WorkOrder;
  current: WorkOrder;
  changes: Record<string, { from: unknown; to: unknown }>;
}

async function patchInTransaction(client: PoolClient, id: string, patch: WorkOrderPatch): Promise<WorkOrderChange | undefined> {
  const locked = await client.query(`SELECT 1 FROM work_orders WHERE id = $1 FOR UPDATE`, [id]);
  if (locked.rowCount === 0) return undefined;
  const previous = (await getWorkOrder(id, client))!;
  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const [field, value] of Object.entries(patch) as [keyof WorkOrderPatch, unknown][]) {
    values.push(value);
    sets.push(`${COLUMN_BY_FIELD[field]} = $${values.length}`);
  }
  if (sets.length > 0) await client.query(`UPDATE work_orders SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, values);
  const current = (await getWorkOrder(id, client))!;
  const changes: WorkOrderChange["changes"] = {};
  for (const field of Object.keys(COLUMN_BY_FIELD) as (keyof WorkOrderPatch)[]) {
    if (previous[field] !== current[field]) changes[field] = { from: previous[field], to: current[field] };
  }
  return { previous, current, changes };
}

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Részleges módosítás egy tranzakcióban (sor zárolva); null törli a nullázható mezőket. */
export function patchWorkOrder(id: string, patch: WorkOrderPatch): Promise<WorkOrderChange | undefined> {
  return inTransaction((client) => patchInTransaction(client, id, patch));
}

/**
 * Tömeges kiadás / törlés. Csak a jogosult státuszú rendelések változnak
 * (BULK_ELIGIBLE); a többit kihagyja és visszaadja, hogy a felület meg
 * tudja mondani, miért nem változtak. Egy tranzakció.
 */
export function bulkWorkOrderStatus(bulk: WorkOrderBulk): Promise<{ changed: WorkOrderChange[]; skipped: { id: string; status: string }[]; unknown: string[] }> {
  const rule = BULK_ELIGIBLE[bulk.action];
  return inTransaction(async (client) => {
    const rows = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM work_orders WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
      [bulk.ids],
    );
    const found = new Map(rows.rows.map((r) => [r.id, r.status]));
    const unknown = bulk.ids.filter((id) => !found.has(id));
    const changed: WorkOrderChange[] = [];
    const skipped: { id: string; status: string }[] = [];
    for (const r of rows.rows) {
      if (!(rule.from as string[]).includes(r.status)) {
        skipped.push({ id: r.id, status: r.status });
        continue;
      }
      const change = await patchInTransaction(client, r.id, { status: rule.to });
      if (change) changed.push(change);
    }
    return { changed, skipped, unknown };
  });
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
export interface AutoCompleteCandidate {
  id: string;
  quantity: number;
  countOverproduction: boolean;
}

/**
 * Az adott géphez (vagy ha nincs megadva, az összes géphez) tartozó,
 * "in_progress" + "auto" lezárási módú munkarendeléseket adja vissza —
 * ezeket kell ellenőrizni, elérték-e a célmennyiséget.
 */
export async function findAutoCompleteCandidates(machineId?: string): Promise<AutoCompleteCandidate[]> {
  const params: unknown[] = [];
  let where = `wo.status = 'in_progress' AND wo.completion_mode = 'auto'`;
  if (machineId) {
    params.push(machineId);
    where = `woa.machine_id = $1 AND ${where}`;
  }
  const result = await pool.query<{ id: string; quantity: number; count_overproduction: boolean }>(
    `SELECT DISTINCT wo.id, wo.quantity, wo.count_overproduction
     FROM work_orders wo
     JOIN work_order_assignments woa ON woa.work_order_id = wo.id
     WHERE ${where}`,
    params,
  );
  return result.rows.map((r) => ({ id: r.id, quantity: r.quantity, countOverproduction: r.count_overproduction }));
}