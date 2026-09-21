import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

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
  };
}

const SELECT_JOINED = `
  SELECT l.*, wo.order_number, m.name AS machine_name
  FROM lots l
  JOIN work_orders wo ON wo.id = l.work_order_id
  LEFT JOIN machines m ON m.id = l.machine_id
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

  const orderResult = await pool.query<{ order_number: string }>(
    `SELECT order_number FROM work_orders WHERE id = $1`,
    [workOrderId],
  );
  const orderNumber = orderResult.rows[0]?.order_number;
  if (!orderNumber) return undefined;

  const assignmentResult = await pool.query<{ machine_id: string }>(
    `SELECT machine_id FROM work_order_assignments WHERE work_order_id = $1 ORDER BY planned_start LIMIT 1`,
    [workOrderId],
  );
  const machineId = assignmentResult.rows[0]?.machine_id ?? null;

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

  let goodCount = 0;
  let scrapCount = 0;
  if (machineId && startedAt) {
    const countsResult = await pool.query<{ good_count: string; scrap_count: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE payload->>'result' = 'good') AS good_count,
         COUNT(*) FILTER (WHERE payload->>'result' = 'scrap') AS scrap_count
       FROM events
       WHERE type = 'production_count' AND machine_id = $1 AND "timestamp" BETWEEN $2 AND now()`,
      [machineId, startedAt],
    );
    goodCount = Number(countsResult.rows[0]?.good_count ?? 0);
    scrapCount = Number(countsResult.rows[0]?.scrap_count ?? 0);
  }

  const lotNumber = `LOT-${orderNumber}`;
  await pool.query(
    `INSERT INTO lots (id, lot_number, work_order_id, machine_id, operator_email, started_at, good_count, scrap_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (lot_number) DO NOTHING`,
    [randomUUID(), lotNumber, workOrderId, machineId, operatorEmail, startedAt, goodCount, scrapCount],
  );

  return getLotForWorkOrder(workOrderId);
}