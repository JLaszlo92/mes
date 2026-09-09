import { pool } from "./db.js";

const POSTGRES_UNIQUE_VIOLATION = "23505";

export interface Machine {
  id: string;
  name: string;
  assetType: string | null;
  location: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

type MachineRow = {
  id: string;
  name: string;
  asset_type: string | null;
  location: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

function toMachine(row: MachineRow): Machine {
  return {
    id: row.id,
    name: row.name,
    assetType: row.asset_type,
    location: row.location,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === POSTGRES_UNIQUE_VIOLATION;
}

export async function listMachines(): Promise<Machine[]> {
  const result = await pool.query<MachineRow>(`SELECT * FROM machines ORDER BY name`);
  return result.rows.map(toMachine);
}

export async function getMachine(id: string): Promise<Machine | undefined> {
  const result = await pool.query<MachineRow>(`SELECT * FROM machines WHERE id = $1`, [id]);
  return result.rows[0] ? toMachine(result.rows[0]) : undefined;
}

export interface CreateMachineInput {
  id: string;
  name: string;
  assetType?: string;
  location?: string;
}

export async function createMachine(input: CreateMachineInput): Promise<Machine> {
  const result = await pool.query<MachineRow>(
    `INSERT INTO machines (id, name, asset_type, location)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.id, input.name, input.assetType ?? null, input.location ?? null],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("INSERT ... RETURNING unexpectedly returned no row");
  }
  return toMachine(row);
}

export interface UpdateMachineInput {
  name?: string;
  assetType?: string;
  location?: string;
  isActive?: boolean;
}

export async function updateMachine(id: string, input: UpdateMachineInput): Promise<Machine | undefined> {
  const result = await pool.query<MachineRow>(
    `UPDATE machines SET
       name = COALESCE($2, name),
       asset_type = COALESCE($3, asset_type),
       location = COALESCE($4, location),
       is_active = COALESCE($5, is_active),
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, input.name ?? null, input.assetType ?? null, input.location ?? null, input.isActive ?? null],
  );
  return result.rows[0] ? toMachine(result.rows[0]) : undefined;
}