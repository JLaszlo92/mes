import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./db.js";
import type { MaintenancePatch, MaintenancePriority } from "./maintenance-input.js";

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
  priority: MaintenancePriority;
  assignedTo: string | null;
  assignedToEmail: string | null;
  createdByEmail: string | null;
  sourceType: string | null;
  sourceId: string | null;
  /** Tervezett karbantartási ablak (037) — a Gantt-hoz; mindkettő vagy egyik sem. */
  plannedStart: string | null;
  plannedEnd: string | null;
  laborHours: number;
  partsCount: number;
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
  priority: MaintenancePriority;
  assigned_to: string | null;
  assigned_to_email: string | null;
  created_by_email: string | null;
  source_type: string | null;
  source_id: string | null;
  planned_start: string | null;
  planned_end: string | null;
  labor_hours: string | null;
  parts_count: string | null;
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
    priority: row.priority,
    assignedTo: row.assigned_to,
    assignedToEmail: row.assigned_to_email,
    createdByEmail: row.created_by_email,
    sourceType: row.source_type,
    sourceId: row.source_id,
    plannedStart: row.planned_start,
    plannedEnd: row.planned_end,
    laborHours: Number(row.labor_hours ?? 0),
    partsCount: Number(row.parts_count ?? 0),
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

const SELECT_JOINED = `
  SELECT
    mwo.*,
    m.name AS machine_name,
    assignee.email AS assigned_to_email,
    creator.email AS created_by_email,
    (SELECT sum(l.hours) FROM maintenance_work_order_labor l WHERE l.work_order_id = mwo.id) AS labor_hours,
    (SELECT count(*) FROM maintenance_work_order_parts p WHERE p.work_order_id = mwo.id) AS parts_count
  FROM maintenance_work_orders mwo
  JOIN machines m ON m.id = mwo.machine_id
  LEFT JOIN users assignee ON assignee.id = mwo.assigned_to
  LEFT JOIN users creator ON creator.id = mwo.created_by
`;

export async function listMaintenanceWorkOrders(): Promise<MaintenanceWorkOrder[]> {
  const result = await pool.query<MwoRow>(`${SELECT_JOINED} ORDER BY mwo.status = 'closed', mwo.created_at DESC`);
  return result.rows.map(toMwo);
}

export async function getMaintenanceWorkOrder(id: string, db: Pick<PoolClient, "query"> = pool): Promise<MaintenanceWorkOrder | undefined> {
  const result = await db.query<MwoRow>(`${SELECT_JOINED} WHERE mwo.id = $1`, [id]);
  return result.rows[0] ? toMwo(result.rows[0]) : undefined;
}

export interface CreateMwoInput {
  machineId: string;
  title: string;
  description?: string | null;
  sourceType?: string;
  sourceId?: string;
  createdBy?: string;
  priority?: MaintenancePriority;
  assignedTo?: string | null;
  plannedStart?: string | null;
  plannedEnd?: string | null;
  status?: MaintenanceStatus;
}

export async function createMaintenanceWorkOrder(input: CreateMwoInput): Promise<MaintenanceWorkOrder> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO maintenance_work_orders
       (id, machine_id, title, description, source_type, source_id, created_by, priority, assigned_to, planned_start, planned_end, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'normal'), $9, $10, $11,
       COALESCE($12, CASE WHEN $9::text IS NOT NULL THEN 'assigned' ELSE 'open' END))
     RETURNING id`,
    [
      randomUUID(),
      input.machineId,
      input.title,
      input.description ?? null,
      input.sourceType ?? null,
      input.sourceId ?? null,
      input.createdBy,
      input.priority ?? null,
      input.assignedTo ?? null,
      input.plannedStart ?? null,
      input.plannedEnd ?? null,
      input.status ?? null,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error("INSERT ... RETURNING unexpectedly returned no row");
  const result = await pool.query<MwoRow>(`${SELECT_JOINED} WHERE mwo.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw new Error("failed to load newly created maintenance work order");
  return toMwo(row);
}

const COLUMN_BY_FIELD: Record<keyof MaintenancePatch, string> = {
  machineId: "machine_id",
  title: "title",
  description: "description",
  status: "status",
  priority: "priority",
  assignedTo: "assigned_to",
  plannedStart: "planned_start",
  plannedEnd: "planned_end",
};

export interface MaintenanceChange {
  previous: MaintenanceWorkOrder;
  current: MaintenanceWorkOrder;
  changes: Record<string, { from: unknown; to: unknown }>;
}

/** Üzleti szabály megsértése → 409 (pl. lezárt rendelés gépcseréje). */
export class MaintenanceConflictError extends Error {}

/** Egyenlőség az audit-diffhez; az időbélyegek (a pg Date-ként adja) időpont szerint. */
function sameInstant(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const isTime = (v: unknown) => v instanceof Date || typeof v === "string";
  if (!isTime(a) || !isTime(b)) return false;
  return new Date(a as string).getTime() === new Date(b as string).getTime();
}

/**
 * Részleges módosítás egy tranzakcióban. A closed_at a státusszal együtt
 * mozog: lezáráskor most, újranyitáskor törlődik (korábban egy újranyitott
 * rendelés megtartotta a régi lezárási idejét).
 */
export async function patchMaintenanceWorkOrder(id: string, patch: MaintenancePatch): Promise<MaintenanceChange | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(`SELECT 1 FROM maintenance_work_orders WHERE id = $1 FOR UPDATE`, [id]);
    if (locked.rowCount === 0) {
      await client.query("ROLLBACK");
      return undefined;
    }
    const previous = (await getMaintenanceWorkOrder(id, client))!;
    if (patch.machineId !== undefined && patch.machineId !== previous.machineId && previous.status === "closed") {
      throw new MaintenanceConflictError("a closed work order cannot be moved to another machine");
    }
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [field, value] of Object.entries(patch) as [keyof MaintenancePatch, unknown][]) {
      values.push(value);
      sets.push(`${COLUMN_BY_FIELD[field]} = $${values.length}`);
    }
    if (patch.status !== undefined && patch.status !== previous.status) {
      sets.push(patch.status === "closed" ? "closed_at = now()" : "closed_at = NULL");
    }
    if (sets.length > 0) await client.query(`UPDATE maintenance_work_orders SET ${sets.join(", ")} WHERE id = $1`, values);
    const current = (await getMaintenanceWorkOrder(id, client))!;
    await client.query("COMMIT");
    const changes: MaintenanceChange["changes"] = {};
    for (const field of Object.keys(COLUMN_BY_FIELD) as (keyof MaintenancePatch)[]) {
      const isTimestamp = field === "plannedStart" || field === "plannedEnd";
      const same = isTimestamp ? sameInstant(previous[field], current[field]) : previous[field] === current[field];
      if (!same) changes[field] = { from: previous[field], to: current[field] };
    }
    return { previous, current, changes };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface AssignableUser {
  id: string;
  email: string;
  role: string;
}

/** Akikhez karbantartási munka rendelhető. */
export async function listAssignableUsers(): Promise<AssignableUser[]> {
  const result = await pool.query<AssignableUser>(
    `SELECT id, email, role FROM users
     WHERE is_active AND role IN ('maintenance', 'supervisor', 'manager', 'admin')
     ORDER BY role = 'maintenance' DESC, email`,
  );
  return result.rows;
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