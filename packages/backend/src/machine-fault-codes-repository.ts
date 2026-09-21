import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

export interface FaultCode {
  id: string;
  machineId: string;
  code: string;
  name: string;
  signalReference: string | null;
  isActive: boolean;
  createdAt: string;
}

type FaultCodeRow = {
  id: string;
  machine_id: string;
  code: string;
  name: string;
  signal_reference: string | null;
  is_active: boolean;
  created_at: string;
};

function toFaultCode(row: FaultCodeRow): FaultCode {
  return {
    id: row.id,
    machineId: row.machine_id,
    code: row.code,
    name: row.name,
    signalReference: row.signal_reference,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

export async function listFaultCodes(machineId?: string): Promise<FaultCode[]> {
  const result = machineId
    ? await pool.query<FaultCodeRow>(`SELECT * FROM machine_fault_codes WHERE machine_id = $1 ORDER BY code`, [
        machineId,
      ])
    : await pool.query<FaultCodeRow>(`SELECT * FROM machine_fault_codes ORDER BY machine_id, code`);
  return result.rows.map(toFaultCode);
}

const MAX_FAULT_CODES_PER_MACHINE = 10;

export class FaultCodeLimitError extends Error {
  constructor() {
    super(`a machine can have at most ${MAX_FAULT_CODES_PER_MACHINE} fault codes`);
  }
}

export interface CreateFaultCodeInput {
  machineId: string;
  code: string;
  name: string;
  signalReference?: string;
}

export async function createFaultCode(input: CreateFaultCodeInput): Promise<FaultCode> {
  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) FROM machine_fault_codes WHERE machine_id = $1 AND is_active`,
    [input.machineId],
  );
  if (Number(countResult.rows[0]?.count ?? 0) >= MAX_FAULT_CODES_PER_MACHINE) {
    throw new FaultCodeLimitError();
  }

  const result = await pool.query<FaultCodeRow>(
    `INSERT INTO machine_fault_codes (id, machine_id, code, name, signal_reference)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [randomUUID(), input.machineId, input.code, input.name, input.signalReference ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error("INSERT ... RETURNING unexpectedly returned no row");
  return toFaultCode(row);
}

export async function deactivateFaultCode(id: string): Promise<boolean> {
  const result = await pool.query(`UPDATE machine_fault_codes SET is_active = false WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23503";
}