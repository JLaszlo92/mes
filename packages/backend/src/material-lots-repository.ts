import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./db.js";
import type { MaterialLotCreate, MaterialLotPatch } from "./material-lot-input.js";

/**
 * Alapanyag-tételek — egyszerű nyilvántartás, NEM raktárkezelés (mennyiség,
 * készlet az ERP-ben van). Egy tétel = a beszállító egy szállítási tétele;
 * a work orderre kötve adja a késztermék-tétel (lots) visszakereshetőségét.
 */
export interface MaterialLot {
  id: string;
  materialName: string;
  lotNumber: string;
  supplier: string | null;
  receivedAt: string | null;
  createdAt: string;
  /** Work orders the lot was recorded on. */
  workOrderCount: number;
  /** Finished lots made from it (work orders already completed). */
  finishedLotCount: number;
  lastUsedAt: string | null;
}

type MaterialLotRow = {
  id: string;
  material_name: string;
  lot_number: string;
  supplier: string | null;
  received_at: string | null;
  created_at: string;
  work_order_count?: string | number | null;
  finished_lot_count?: string | number | null;
  last_used_at?: string | null;
};

function toMaterialLot(row: MaterialLotRow): MaterialLot {
  return {
    id: row.id,
    materialName: row.material_name,
    lotNumber: row.lot_number,
    supplier: row.supplier,
    receivedAt: row.received_at,
    createdAt: row.created_at,
    workOrderCount: Number(row.work_order_count ?? 0),
    finishedLotCount: Number(row.finished_lot_count ?? 0),
    lastUsedAt: row.last_used_at ?? null,
  };
}

const SELECT_WITH_USAGE = `
  SELECT ml.*, u.work_order_count, u.finished_lot_count, u.last_used_at
  FROM material_lots ml
  LEFT JOIN LATERAL (
    SELECT count(*) AS work_order_count,
           count(l.id) AS finished_lot_count,
           max(c.recorded_at) AS last_used_at
    FROM work_order_material_consumption c
    LEFT JOIN lots l ON l.work_order_id = c.work_order_id
    WHERE c.material_lot_id = ml.id
  ) u ON true`;

export async function listMaterialLots(): Promise<MaterialLot[]> {
  const result = await pool.query<MaterialLotRow>(`${SELECT_WITH_USAGE} ORDER BY ml.created_at DESC`);
  return result.rows.map(toMaterialLot);
}

export async function getMaterialLot(id: string, db: Pick<PoolClient, "query"> = pool): Promise<MaterialLot | undefined> {
  const result = await db.query<MaterialLotRow>(`${SELECT_WITH_USAGE} WHERE ml.id = $1`, [id]);
  return result.rows[0] ? toMaterialLot(result.rows[0]) : undefined;
}

export async function createMaterialLot(input: MaterialLotCreate): Promise<MaterialLot> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO material_lots (id, material_name, lot_number, supplier, received_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, input.materialName, input.lotNumber, input.supplier ?? null, input.receivedAt ?? null],
  );
  const created = await getMaterialLot(id);
  if (!created) throw new Error("INSERT succeeded but the material lot could not be read back");
  return created;
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

const COLUMN_BY_FIELD: Record<keyof MaterialLotPatch, string> = {
  materialName: "material_name",
  lotNumber: "lot_number",
  supplier: "supplier",
  receivedAt: "received_at",
};

export interface MaterialLotChange {
  current: MaterialLot;
  changes: Record<string, { from: unknown; to: unknown }>;
}

/** Részleges módosítás egy tranzakcióban, a sor zárolva; csak a változott mezők kerülnek a diffbe. */
export function updateMaterialLot(id: string, patch: MaterialLotPatch): Promise<MaterialLotChange | undefined> {
  return inTransaction(async (client) => {
    const locked = await client.query(`SELECT 1 FROM material_lots WHERE id = $1 FOR UPDATE`, [id]);
    if (locked.rowCount === 0) return undefined;
    const previous = (await getMaterialLot(id, client))!;
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [field, value] of Object.entries(patch) as [keyof MaterialLotPatch, unknown][]) {
      values.push(value);
      sets.push(`${COLUMN_BY_FIELD[field]} = $${values.length}`);
    }
    await client.query(`UPDATE material_lots SET ${sets.join(", ")} WHERE id = $1`, values);
    const current = (await getMaterialLot(id, client))!;
    const changes: MaterialLotChange["changes"] = {};
    for (const field of Object.keys(COLUMN_BY_FIELD) as (keyof MaterialLotPatch)[]) {
      if (previous[field] !== current[field]) changes[field] = { from: previous[field], to: current[field] };
    }
    return { current, changes };
  });
}

/**
 * Csak felhasználatlan tétel törölhető. A work_order_material_consumption FK
 * ON DELETE CASCADE, vagyis egy használt tétel törlése csendben eltüntetné a
 * nyomonkövetési kapcsolatot — ezt itt, zárolt sorral zárjuk ki.
 */
export function deleteMaterialLotIfUnused(id: string): Promise<{ deleted: MaterialLot } | "not_found" | { inUse: number }> {
  return inTransaction(async (client) => {
    const locked = await client.query(`SELECT 1 FROM material_lots WHERE id = $1 FOR UPDATE`, [id]);
    if (locked.rowCount === 0) return "not_found" as const;
    const lot = (await getMaterialLot(id, client))!;
    if (lot.workOrderCount > 0) return { inUse: lot.workOrderCount };
    await client.query(`DELETE FROM material_lots WHERE id = $1`, [id]);
    return { deleted: lot };
  });
}

/** Hol használták: a work orderek, és ahol már lezárult, a késztermék-tétel. */
export interface MaterialLotUsage {
  workOrderId: string;
  orderNumber: string;
  partName: string;
  workOrderStatus: string;
  recordedAt: string;
  recordedByEmail: string | null;
  lot: { lotNumber: string; goodCount: number; scrapCount: number; completedAt: string; machineName: string | null } | null;
}

export async function listMaterialLotUsage(materialLotId: string): Promise<MaterialLotUsage[]> {
  const result = await pool.query<{
    work_order_id: string;
    order_number: string;
    part_name: string;
    status: string;
    recorded_at: string;
    recorded_by_email: string | null;
    lot_number: string | null;
    good_count: number | null;
    scrap_count: number | null;
    completed_at: string | null;
    machine_name: string | null;
  }>(
    `SELECT c.work_order_id, wo.order_number, wo.part_name, wo.status, c.recorded_at,
            u.email AS recorded_by_email,
            l.lot_number, l.good_count, l.scrap_count, l.completed_at, m.name AS machine_name
     FROM work_order_material_consumption c
     JOIN work_orders wo ON wo.id = c.work_order_id
     LEFT JOIN users u ON u.id = c.recorded_by
     LEFT JOIN lots l ON l.work_order_id = c.work_order_id
     LEFT JOIN machines m ON m.id = l.machine_id
     WHERE c.material_lot_id = $1
     ORDER BY c.recorded_at DESC`,
    [materialLotId],
  );
  return result.rows.map((r) => ({
    workOrderId: r.work_order_id,
    orderNumber: r.order_number,
    partName: r.part_name,
    workOrderStatus: r.status,
    recordedAt: r.recorded_at,
    recordedByEmail: r.recorded_by_email,
    lot:
      r.lot_number !== null
        ? { lotNumber: r.lot_number, goodCount: r.good_count ?? 0, scrapCount: r.scrap_count ?? 0, completedAt: r.completed_at!, machineName: r.machine_name }
        : null,
  }));
}

export interface ConsumedMaterial {
  materialLotId: string;
  materialName: string;
  lotNumber: string;
  recordedAt: string;
}

export async function listConsumptionForWorkOrder(workOrderId: string): Promise<ConsumedMaterial[]> {
  const result = await pool.query<{
    material_lot_id: string;
    material_name: string;
    lot_number: string;
    recorded_at: string;
  }>(
    `SELECT womc.material_lot_id, ml.material_name, ml.lot_number, womc.recorded_at
     FROM work_order_material_consumption womc
     JOIN material_lots ml ON ml.id = womc.material_lot_id
     WHERE womc.work_order_id = $1
     ORDER BY womc.recorded_at`,
    [workOrderId],
  );
  return result.rows.map((r) => ({
    materialLotId: r.material_lot_id,
    materialName: r.material_name,
    lotNumber: r.lot_number,
    recordedAt: r.recorded_at,
  }));
}

export async function recordConsumption(workOrderId: string, materialLotId: string, recordedBy: string): Promise<void> {
  await pool.query(
    `INSERT INTO work_order_material_consumption (id, work_order_id, material_lot_id, recorded_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (work_order_id, material_lot_id) DO NOTHING`,
    [randomUUID(), workOrderId, materialLotId, recordedBy],
  );
}

/** `false`: nothing was recorded for this pair. */
export async function removeConsumption(workOrderId: string, materialLotId: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM work_order_material_consumption WHERE work_order_id = $1 AND material_lot_id = $2`,
    [workOrderId, materialLotId],
  );
  return (result.rowCount ?? 0) > 0;
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23503";
}
