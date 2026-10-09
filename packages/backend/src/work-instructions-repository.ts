import { createHash, randomUUID } from "node:crypto";
import { pool } from "./db.js";

export interface WorkInstruction {
  id: string;
  partName: string;
  version: number;
  content: string;
  /** Link to a document stored somewhere else (older instructions). */
  pdfUrl: string | null;
  /** An uploaded PDF: GET /api/work-instructions/files/:id. */
  pdfFileId: string | null;
  pdfFileName: string | null;
  pdfSizeBytes: number | null;
  isCurrent: boolean;
  createdByEmail: string | null;
  createdAt: string;
  /** Only in the list of current instructions: open work orders that use it. */
  openWorkOrders?: number;
}

type WorkInstructionRow = {
  id: string;
  part_name: string;
  version: number;
  content: string;
  pdf_url: string | null;
  pdf_file_id: string | null;
  pdf_file_name: string | null;
  pdf_size_bytes: number | null;
  is_current: boolean;
  created_by_email: string | null;
  created_at: string;
  open_work_orders?: string | number | null;
};

function toWorkInstruction(row: WorkInstructionRow): WorkInstruction {
  const instruction: WorkInstruction = {
    id: row.id,
    partName: row.part_name,
    version: row.version,
    content: row.content,
    pdfUrl: row.pdf_url,
    pdfFileId: row.pdf_file_id,
    pdfFileName: row.pdf_file_id ? (row.pdf_file_name ?? "document.pdf") : null,
    pdfSizeBytes: row.pdf_file_id ? (row.pdf_size_bytes ?? null) : null,
    isCurrent: row.is_current,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
  if (row.open_work_orders !== undefined && row.open_work_orders !== null) instruction.openWorkOrders = Number(row.open_work_orders);
  return instruction;
}

// Never selects work_instruction_files.content: lists stay small.
const COLUMNS = `wi.*, u.email AS created_by_email, f.size_bytes AS pdf_size_bytes`;
const JOINS = `
  FROM work_instructions wi
  LEFT JOIN users u ON u.id = wi.created_by
  LEFT JOIN work_instruction_files f ON f.id = wi.pdf_file_id
`;
const SELECT_JOINED = `SELECT ${COLUMNS} ${JOINS}`;

/**
 * The instruction a work order uses is the one named in
 * work_orders.work_instruction_name, or, when that is empty, the one named
 * like the part. Keep this expression the same everywhere.
 */
const INSTRUCTION_NAME_OF_ORDER = `COALESCE(wo.work_instruction_name, wo.part_name)`;

export async function listCurrentInstructions(): Promise<WorkInstruction[]> {
  const result = await pool.query<WorkInstructionRow>(
    `SELECT ${COLUMNS},
            (SELECT count(*) FROM work_orders wo
              WHERE wo.status IN ('planned', 'released', 'in_progress')
                AND ${INSTRUCTION_NAME_OF_ORDER} = wi.part_name) AS open_work_orders
     ${JOINS}
     WHERE wi.is_current
     ORDER BY wi.part_name`,
  );
  return result.rows.map(toWorkInstruction);
}

export async function getCurrentInstructionForPart(partName: string): Promise<WorkInstruction | undefined> {
  const result = await pool.query<WorkInstructionRow>(`${SELECT_JOINED} WHERE wi.part_name = $1 AND wi.is_current`, [
    partName,
  ]);
  return result.rows[0] ? toWorkInstruction(result.rows[0]) : undefined;
}

/** `undefined`: no such work order; `null`: the order has no instruction. */
export async function getInstructionForWorkOrder(workOrderId: string): Promise<WorkInstruction | null | undefined> {
  const result = await pool.query<WorkInstructionRow & { wo_id: string }>(
    `SELECT wo.id AS wo_id, i.*
     FROM work_orders wo
     LEFT JOIN LATERAL (
       ${SELECT_JOINED}
       WHERE wi.is_current AND wi.part_name = ${INSTRUCTION_NAME_OF_ORDER}
       LIMIT 1
     ) i ON true
     WHERE wo.id = $1`,
    [workOrderId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  // LEFT JOIN: every instruction column is NULL when nothing matched. `i.id`
  // would collide with wo.id, hence the alias and this check on a NOT NULL column.
  return row.part_name === null || row.part_name === undefined ? null : toWorkInstruction(row);
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
  pdfUrl?: string | null;
  pdfFileId?: string | null;
  pdfFileName?: string | null;
  createdBy: string;
}

/**
 * Egy új verzió mindig ÚJ sor, sosem felülírás — így a teljes verzió-
 * történet megmarad, és egy megtekintés-napló bejegyzés mindig egy
 * változatlan, visszakereshető verzióra mutat. A szerkesztés is ez: az
 * előző verzió megmarad, csak már nem "current".
 */
export async function createNewVersion(input: CreateVersionInput): Promise<WorkInstruction> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Two saves of the same instruction at once would both compute the same next version.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('work_instruction:' || $1))`, [input.partName]);
    const maxVersionResult = await client.query<{ max: number | null }>(
      `SELECT MAX(version) AS max FROM work_instructions WHERE part_name = $1`,
      [input.partName],
    );
    const nextVersion = (maxVersionResult.rows[0]?.max ?? 0) + 1;

    await client.query(`UPDATE work_instructions SET is_current = false WHERE part_name = $1 AND is_current`, [input.partName]);

    const id = randomUUID();
    await client.query(
      `INSERT INTO work_instructions (id, part_name, version, content, pdf_url, pdf_file_id, pdf_file_name, is_current, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)`,
      [
        id,
        input.partName,
        nextVersion,
        input.content,
        input.pdfUrl ?? null,
        input.pdfFileId ?? null,
        input.pdfFileId ? (input.pdfFileName ?? "document.pdf") : null,
        input.createdBy,
      ],
    );
    await client.query("COMMIT");

    const result = await pool.query<WorkInstructionRow>(`${SELECT_JOINED} WHERE wi.id = $1`, [id]);
    const row = result.rows[0];
    if (!row) throw new Error("failed to load newly created work instruction version");
    return toWorkInstruction(row);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------- files

export interface StoredFile {
  id: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Stores an uploaded PDF. The same bytes are stored once: a second upload
 * returns the existing row. Files that no version ever used (an upload whose
 * save was abandoned) are removed after a day.
 */
export async function storeInstructionFile(content: Buffer, uploadedBy: string): Promise<StoredFile> {
  await pool.query(
    `DELETE FROM work_instruction_files f
     WHERE f.uploaded_at < now() - interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM work_instructions wi WHERE wi.pdf_file_id = f.id)`,
  );
  const sha256 = createHash("sha256").update(content).digest("hex");
  // DO UPDATE (not DO NOTHING) so that RETURNING yields the existing row, and
  // a re-used orphan counts as fresh for the cleanup above.
  const result = await pool.query<{ id: string; size_bytes: number; sha256: string }>(
    `INSERT INTO work_instruction_files (id, sha256, size_bytes, content, uploaded_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (sha256) DO UPDATE SET uploaded_at = now()
     RETURNING id, size_bytes, sha256`,
    [randomUUID(), sha256, content.length, content, uploadedBy],
  );
  const row = result.rows[0];
  if (!row) throw new Error("INSERT ... RETURNING unexpectedly returned no row");
  return { id: row.id, sizeBytes: row.size_bytes, sha256: row.sha256 };
}

export async function instructionFileExists(id: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM work_instruction_files WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

/** Only the checksum: lets the route answer 304 without reading the file. */
export async function getInstructionFileSha(id: string): Promise<string | undefined> {
  const result = await pool.query<{ sha256: string }>(`SELECT sha256 FROM work_instruction_files WHERE id = $1`, [id]);
  return result.rows[0]?.sha256;
}

export async function getInstructionFile(id: string): Promise<{ content: Buffer; sha256: string } | undefined> {
  const result = await pool.query<{ content: Buffer; sha256: string }>(
    `SELECT content, sha256 FROM work_instruction_files WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

// ---------------------------------------------------------------- views

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

/** Newest first; `partName` narrows it to one instruction (all its versions). */
export async function listViews(limit = 100, partName?: string): Promise<InstructionView[]> {
  const result = await pool.query<ViewRow>(
    `SELECT
       v.id, wi.part_name, wi.version,
       wo.order_number,
       u.email AS viewed_by_email, v.viewed_at
     FROM work_instruction_views v
     JOIN work_instructions wi ON wi.id = v.work_instruction_id
     LEFT JOIN work_orders wo ON wo.id = v.work_order_id
     LEFT JOIN users u ON u.id = v.viewed_by
     WHERE ($2::text IS NULL OR wi.part_name = $2)
     ORDER BY v.viewed_at DESC
     LIMIT $1`,
    [limit, partName ?? null],
  );
  return result.rows.map(toView);
}

export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23503";
}
