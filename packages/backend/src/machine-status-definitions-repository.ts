import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

export type OeeCategory = "counts_as_down" | "excluded";

export interface StatusDefinition {
  id: string;
  machineId: string | null;
  code: string;
  displayName: string;
  oeeCategory: OeeCategory;
  color: string | null;
  /** A manual status with this code stops the running signal and the part count until it is ended. */
  blocksProduction: boolean;
}

type Row = {
  id: string;
  machine_id: string | null;
  code: string;
  display_name: string;
  oee_category: OeeCategory;
  color: string | null;
  blocks_production: boolean;
};

function toDefinition(row: Row): StatusDefinition {
  return {
    id: row.id,
    machineId: row.machine_id,
    code: row.code,
    displayName: row.display_name,
    oeeCategory: row.oee_category,
    color: row.color,
    blocksProduction: row.blocks_production,
  };
}

export async function listStatusDefinitions(): Promise<StatusDefinition[]> {
  const result = await pool.query<Row>(
    `SELECT * FROM machine_status_definitions ORDER BY machine_id NULLS FIRST, code`,
  );
  return result.rows.map(toDefinition);
}

export interface CreateStatusDefinitionInput {
  machineId?: string;
  code: string;
  displayName: string;
  oeeCategory: OeeCategory;
  color?: string;
  blocksProduction?: boolean;
}

export async function createStatusDefinition(input: CreateStatusDefinitionInput): Promise<StatusDefinition> {
  const result = await pool.query<Row>(
    `INSERT INTO machine_status_definitions (id, machine_id, code, display_name, oee_category, color, blocks_production)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [randomUUID(), input.machineId ?? null, input.code, input.displayName, input.oeeCategory, input.color ?? null, input.blocksProduction === true],
  );
  const row = result.rows[0];
  if (!row) throw new Error("INSERT ... RETURNING unexpectedly returned no row");
  return toDefinition(row);
}

export interface UpdateStatusDefinitionInput {
  displayName?: string;
  oeeCategory?: OeeCategory;
  color?: string | null;
  blocksProduction?: boolean;
}

/** Changes the editable fields (not the code or the scope: events and manual statuses refer to the code). */
export async function updateStatusDefinition(id: string, input: UpdateStatusDefinitionInput): Promise<{ before: StatusDefinition; after: StatusDefinition } | undefined> {
  const current = await pool.query<Row>(`SELECT * FROM machine_status_definitions WHERE id = $1`, [id]);
  if (!current.rows[0]) return undefined;
  const before = toDefinition(current.rows[0]);
  const result = await pool.query<Row>(
    `UPDATE machine_status_definitions SET display_name = $2, oee_category = $3, color = $4, blocks_production = $5 WHERE id = $1 RETURNING *`,
    [
      id,
      input.displayName ?? before.displayName,
      input.oeeCategory ?? before.oeeCategory,
      input.color === undefined ? before.color : input.color,
      input.blocksProduction ?? before.blocksProduction,
    ],
  );
  return { before, after: toDefinition(result.rows[0]!) };
}

export async function deleteStatusDefinition(id: string): Promise<boolean> {
  const result = await pool.query(`DELETE FROM machine_status_definitions WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23503";
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}