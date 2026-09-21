import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

export interface MaterialLot {
  id: string;
  materialName: string;
  lotNumber: string;
  supplier: string | null;
  receivedAt: string | null;
}

type MaterialLotRow = {
  id: string;
  material_name: string;
  lot_number: string;
  supplier: string | null;
  received_at: string | null;
};

function toMaterialLot(row: MaterialLotRow): MaterialLot {
  return {
    id: row.id,
    materialName: row.material_name,
    lotNumber: row.lot_number,
    supplier: row.supplier,
    receivedAt: row.received_at,
  };
}

export async function listMaterialLots(): Promise<MaterialLot[]> {
  const result = await pool.query<MaterialLotRow>(`SELECT * FROM material_lots ORDER BY created_at DESC`);
  return result.rows.map(toMaterialLot);
}

export interface CreateMaterialLotInput {
  materialName: string;
  lotNumber: string;
  supplier?: string;
  receivedAt?: string;
}

export async function createMaterialLot(input: CreateMaterialLotInput): Promise<MaterialLot> {
  const result = await pool.query<MaterialLotRow>(
    `INSERT INTO material_lots (id, material_name, lot_number, supplier, received_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [randomUUID(), input.materialName, input.lotNumber, input.supplier ?? null, input.receivedAt ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error("INSERT ... RETURNING unexpectedly returned no row");
  return toMaterialLot(row);
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

export async function recordConsumption(
  workOrderId: string,
  materialLotId: string,
  recordedBy: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO work_order_material_consumption (id, work_order_id, material_lot_id, recorded_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (work_order_id, material_lot_id) DO NOTHING`,
    [randomUUID(), workOrderId, materialLotId, recordedBy],
  );
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23503";
}