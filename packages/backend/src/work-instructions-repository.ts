import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

export interface WorkInstruction {
  id: string;
  partName: string;
  version: number;
  content: string;
  pdfUrl: string | null;
  isCurrent: boolean;
  createdByEmail: string | null;
  createdAt: string;
}

type WorkInstructionRow = {
  id: string;
  part_name: string;
  version: number;
  content: string;
  pdf_url: string | null;
  is_current: boolean;
  created_by_email: string | null;
  created_at: string;
};

function toWorkInstruction(row: WorkInstructionRow): WorkInstruction {
  return {
    id: row.id,
    partName: row.part_name,
    version: row.version,
    content: row.content,
    pdfUrl: row.pdf_url,
    isCurrent: row.is_current,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
}

const SELECT_JOINED = `
  SELECT wi.*, u.email AS created_by_email
  FROM work_instructions wi
  LEFT JOIN users u ON u.id = wi.created_by
`;

export async function listCurrentInstructions(): Promise<WorkInstruction[]> {
  const result = await pool.query<WorkInstructionRow>(`${SELECT_JOINED} WHERE wi.is_current ORDER BY wi.part_name`);
  return result.rows.map(toWorkInstruction);
}

export async function getCurrentInstructionForPart(partName: string): Promise<WorkInstruction | undefined> {
  const result = await pool.query<WorkInstructionRow>(`${SELECT_JOINED} WHERE wi.part_name = $1 AND wi.is_current`, [
    partName,
  ]);
  return result.rows[0] ? toWorkInstruction(result.rows[0]) : undefined;
}

export async function listVersionsForPart(partName: string): Promise<WorkInstruction[]> {
  const result = await pool.query<WorkInstructionRow>(`${SELECT_JOINED} WHERE wi.part_name = $1 ORDER BY wi.version DESC`, [
    partName,
  ]);
  return result.rows.map(toWorkInstruction);
}

export interface CreateVersionInput {
  partName: string;
  content: string;
  pdfUrl?: string;
  createdBy: string;
}

/**
 * Egy új verzió mindig ÚJ sor, sosem felülírás — így a teljes verzió-
 * történet megmarad, és egy megtekintés-napló bejegyzés mindig egy
 * változatlan, visszakereshető verzióra mutat.
 */
export async function createNewVersion(input: CreateVersionInput): Promise<WorkInstruction> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const maxVersionResult = await client.query<{ max: number | null }>(
      `SELECT MAX(version) AS max FROM work_instructions WHERE part_name = $1`,
      [input.partName],
    );
    const nextVersion = (maxVersionResult.rows[0]?.max ?? 0) + 1;

    await client.query(`UPDATE work_instructions SET is_current = false WHERE part_name = $1`, [input.partName]);

    const id = randomUUID();
    await client.query(
      `INSERT INTO work_instructions (id, part_name, version, content, pdf_url, is_current, created_by)
       VALUES ($1, $2, $3, $4, $5, true, $6)`,
      [id, input.partName, nextVersion, input.content, input.pdfUrl ?? null, input.createdBy],
    );
    await client.query("COMMIT");

    const result = await pool.query<WorkInstructionRow>(`${SELECT_JOINED} WHERE wi.id = $1`, [id]);
    const row = result.rows[0];
    if (!row) throw new Error("failed to load newly created work instruction version");
    return toWorkInstruction(row);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function recordView(
  workInstructionId: string,
  workOrderId: string | null,
  viewedBy: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO work_instruction_views (id, work_instruction_id, work_order_id, viewed_by)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), workInstructionId, workOrderId, viewedBy],
  );
}

export interface InstructionView {
  id: string;
  partName: string;
  version: number;
  orderNumber: string | null;
  viewedByEmail: string | null;
  viewedAt: string;
}

type ViewRow = {
  id: string;
  part_name: string;
  version: number;
  order_number: string | null;
  viewed_by_email: string | null;
  viewed_at: string;
};

function toView(row: ViewRow): InstructionView {
  return {
    id: row.id,
    partName: row.part_name,
    version: row.version,
    orderNumber: row.order_number,
    viewedByEmail: row.viewed_by_email,
    viewedAt: row.viewed_at,
  };
}

export async function listViews(limit = 100): Promise<InstructionView[]> {
  const result = await pool.query<ViewRow>(
    `SELECT
       v.id, wi.part_name, wi.version,
       wo.order_number,
       u.email AS viewed_by_email, v.viewed_at
     FROM work_instruction_views v
     JOIN work_instructions wi ON wi.id = v.work_instruction_id
     LEFT JOIN work_orders wo ON wo.id = v.work_order_id
     LEFT JOIN users u ON u.id = v.viewed_by
     ORDER BY v.viewed_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows.map(toView);
}