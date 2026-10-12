import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
import { computeWorkOrderProgress } from "./work-orders-repository.js";

export interface Lot {
  id: string;
  lotNumber: string;
  workOrderId: string;
  orderNumber: string;
  machineId: string | null;
  machineName: string | null;
  operatorEmail: string | null;
  startedAt: string | null;
  completedAt: string;
  goodCount: number;
  scrapCount: number;
  partName: string;
  /** Planned quantity of the work order. */
  quantity: number;
  /** Material lots recorded on the work order. */
  materials: LotMaterial[];
}

export interface LotMaterial {
  materialLotId: string;
  materialName: string;
  lotNumber: string;
  supplier: string | null;
  receivedAt: string | null;
}

type LotRow = {
  id: string;
  lot_number: string;
  work_order_id: string;
  order_number: string;
  machine_id: string | null;
  machine_name: string | null;
  operator_email: string | null;
  started_at: string | null;
  completed_at: string;
  good_count: number;
  scrap_count: number;
  part_name: string;
  quantity: number;
  materials: LotMaterial[] | null;
};

function toLot(row: LotRow): Lot {
  return {
    id: row.id,
    lotNumber: row.lot_number,
    workOrderId: row.work_order_id,
    orderNumber: row.order_number,
    machineId: row.machine_id,
    machineName: row.machine_name,
    operatorEmail: row.operator_email,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    goodCount: row.good_count,
    scrapCount: row.scrap_count,
    partName: row.part_name,
    quantity: row.quantity,
    materials: row.materials ?? [],
  };
}

const SELECT_JOINED = `
  SELECT l.*, wo.order_number, wo.part_name, wo.quantity, m.name AS machine_name, mat.materials
  FROM lots l
  JOIN work_orders wo ON wo.id = l.work_order_id
  LEFT JOIN machines m ON m.id = l.machine_id
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object(
             'materialLotId', ml.id, 'materialName', ml.material_name, 'lotNumber', ml.lot_number,
             'supplier', ml.supplier, 'receivedAt', ml.received_at
           ) ORDER BY c.recorded_at, ml.id) AS materials
    FROM work_order_material_consumption c
    JOIN material_lots ml ON ml.id = c.material_lot_id
    WHERE c.work_order_id = l.work_order_id
  ) mat ON true
`;

export async function listLots(): Promise<Lot[]> {
  const result = await pool.query<LotRow>(`${SELECT_JOINED} ORDER BY l.completed_at DESC`);
  return result.rows.map(toLot);
}

export async function getLotForWorkOrder(workOrderId: string): Promise<Lot | undefined> {
  const result = await pool.query<LotRow>(`${SELECT_JOINED} WHERE l.work_order_id = $1`, [workOrderId]);
  return result.rows[0] ? toLot(result.rows[0]) : undefined;
}

/**
 * Automatikusan létrehozza a genealógia-rekordot egy munkarendelés
 * lezárásakor — a gépet a work_order_assignments-ből, az operátort és a
 * kezdés időpontját az audit logból (amikor "in_progress"-re váltott),
 * a jó/selejt darabszámot a tényleges events táblából. PRD 5.10: "a
 * genealogy record built automatically from data the other modules are
 * already capturing, not a separate data-entry step."
 */
export async function generateLotForWorkOrder(workOrderId: string): Promise<Lot | undefined> {
  const existing = await getLotForWorkOrder(workOrderId);
  if (existing) return existing;

  const orderResult = await pool.query<{ order_number: string; quantity: number; count_overproduction: boolean }>(
    `SELECT order_number, quantity, count_overproduction FROM work_orders WHERE id = $1`,
    [workOrderId],
  );
  const order = orderResult.rows[0];
  if (!order) return undefined;

  const progress = await computeWorkOrderProgress(workOrderId, order.quantity, order.count_overproduction);

  const lotNumber = `LOT-${order.order_number}`;
  await pool.query(
    `INSERT INTO lots (id, lot_number, work_order_id, machine_id, operator_email, started_at, good_count, scrap_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (lot_number) DO NOTHING`,
    [
      randomUUID(),
      lotNumber,
      workOrderId,
      progress.machineId,
      progress.operatorEmail,
      progress.startedAt,
      progress.goodCount,
      progress.scrapCount,
    ],
  );

  return getLotForWorkOrder(workOrderId);
}