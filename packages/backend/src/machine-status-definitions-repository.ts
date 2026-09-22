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
}

type Row = {
  id: string;
  machine_id: string | null;
  code: string;
  display_name: string;
  oee_category: OeeCategory;
  color: string | null;
};

function toDefinition(row: Row): StatusDefinition {
  return {
    id: row.id,
    machineId: row.machine_id,
    code: row.code,
    displayName: row.display_name,
    oeeCategory: row.oee_category,
    color: row.color,
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
}

export async function createStatusDefinition(input: CreateStatusDefinitionInput): Promise<StatusDefinition> {
  const result = await pool.query<Row>(
    `INSERT INTO machine_status_definitions (id, machine_id, code, display_name, oee_category, color)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [randomUUID(), input.machineId ?? null, input.code, input.displayName, input.oeeCategory, input.color ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error("INSERT ... RETURNING unexpectedly returned no row");
  return toDefinition(row);
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