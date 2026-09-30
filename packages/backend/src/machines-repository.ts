import type { PoolClient } from "pg";
import { pool } from "./db.js";
import type { MachineCreate, MachinePatch } from "./machine-input.js";

const POSTGRES_UNIQUE_VIOLATION = "23505";
const POSTGRES_FOREIGN_KEY_VIOLATION = "23503";

export interface Machine {
  id: string;
  name: string;
  assetType: string | null;
  /** Régi szabad szöveges hely — az új UI csak olvassa; helyette area/line. */
  location: string | null;
  idealCycleTimeSeconds: number | null;
  isActive: boolean;
  siteId: string;
  areaId: string;
  lineId: string | null;
  shiftPatternId: string | null;
  calendarId: string | null;
  autoOffshiftStatus: boolean;
  microStopThresholdSeconds: number;
  createdAt: string;
  updatedAt: string;
}

type MachineRow = {
  id: string;
  name: string;
  asset_type: string | null;
  location: string | null;
  is_active: boolean;
  site_id: string;
  area_id: string;
  line_id: string | null;
  shift_pattern_id: string | null;
  calendar_id: string | null;
  auto_offshift_status: boolean;
  micro_stop_threshold_seconds: number;
  created_at: string;
  updated_at: string;
  ideal_cycle_time_seconds: string | null;
};

// A telephely a részlegből származik — minden olvasás ezen a joinon megy át.
const SELECT_MACHINE = `
  SELECT m.*, a.site_id
  FROM machines m
  JOIN areas a ON a.id = m.area_id`;

function toMachine(row: MachineRow): Machine {
  return {
    id: row.id,
    name: row.name,
    assetType: row.asset_type,
    location: row.location,
    isActive: row.is_active,
    siteId: row.site_id,
    areaId: row.area_id,
    lineId: row.line_id,
    shiftPatternId: row.shift_pattern_id,
    calendarId: row.calendar_id,
    autoOffshiftStatus: row.auto_offshift_status,
    microStopThresholdSeconds: row.micro_stop_threshold_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    idealCycleTimeSeconds: row.ideal_cycle_time_seconds !== null ? Number(row.ideal_cycle_time_seconds) : null,
  };
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === POSTGRES_UNIQUE_VIOLATION;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === POSTGRES_FOREIGN_KEY_VIOLATION;
}

/** Üzleti szabály megsértése (pl. a sor nem a megadott részleghez tartozik) → 400. */
export class MachineInputError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

/** active: undefined = mind, true = csak aktív, false = csak deaktivált. */
export async function listMachines(filter: { active?: boolean } = {}): Promise<Machine[]> {
  const result = await pool.query<MachineRow>(
    `${SELECT_MACHINE}
     WHERE ($1::boolean IS NULL OR m.is_active = $1)
     ORDER BY m.name`,
    [filter.active ?? null],
  );
  return result.rows.map(toMachine);
}

export async function getMachine(id: string, db: Pick<PoolClient, "query"> = pool): Promise<Machine | undefined> {
  const result = await db.query<MachineRow>(`${SELECT_MACHINE} WHERE m.id = $1`, [id]);
  return result.rows[0] ? toMachine(result.rows[0]) : undefined;
}

async function lineArea(client: PoolClient, lineId: string): Promise<string> {
  const r = await client.query<{ area_id: string }>(`SELECT area_id FROM lines WHERE id = $1`, [lineId]);
  if (!r.rows[0]) throw new MachineInputError("lineId", `unknown line "${lineId}"`);
  return r.rows[0].area_id;
}

/**
 * A részleg/sor páros feloldása:
 *  - sor megadva → a részleg a soré (ha a részleg is meg van adva és eltér: hiba);
 *  - csak részleg változik → a jelenlegi sor megmarad, ha az új részleghez
 *    tartozik, különben kiürül (másik részlegbe áthelyezett gépnek nincs
 *    értelme a régi során maradni).
 */
async function resolvePlacement(
  client: PoolClient,
  patch: Pick<MachinePatch, "areaId" | "lineId">,
  current: { areaId: string; lineId: string | null } | null,
): Promise<{ areaId?: string; lineId?: string | null }> {
  if (patch.lineId !== undefined && patch.lineId !== null) {
    const areaOfLine = await lineArea(client, patch.lineId);
    if (patch.areaId !== undefined && patch.areaId !== areaOfLine) {
      throw new MachineInputError("lineId", "the selected line does not belong to the selected area");
    }
    return { areaId: areaOfLine, lineId: patch.lineId };
  }
  if (patch.lineId === null) return { areaId: patch.areaId, lineId: null };
  if (patch.areaId !== undefined && current?.lineId) {
    const areaOfCurrentLine = await lineArea(client, current.lineId);
    return { areaId: patch.areaId, lineId: areaOfCurrentLine === patch.areaId ? current.lineId : null };
  }
  return { areaId: patch.areaId };
}

const COLUMN_BY_FIELD: Record<keyof MachinePatch, string> = {
  name: "name",
  assetType: "asset_type",
  location: "location",
  idealCycleTimeSeconds: "ideal_cycle_time_seconds",
  isActive: "is_active",
  areaId: "area_id",
  lineId: "line_id",
  shiftPatternId: "shift_pattern_id",
  calendarId: "calendar_id",
  autoOffshiftStatus: "auto_offshift_status",
  microStopThresholdSeconds: "micro_stop_threshold_seconds",
};

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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

export async function createMachine(input: MachineCreate): Promise<Machine> {
  return withTransaction(async (client) => {
    const placement = await resolvePlacement(client, input, null);
    // Műszakminta/naptár hiányában az alapértelmezettek (023) — ha még léteznek.
    // Korábban ezek NULL-ok maradtak a következő újraindításig.
    await client.query(
      `INSERT INTO machines (
         id, name, asset_type, location, ideal_cycle_time_seconds, is_active,
         area_id, line_id, shift_pattern_id, calendar_id, auto_offshift_status, micro_stop_threshold_seconds)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, true), $7, $8,
         COALESCE($9, (SELECT id FROM shift_patterns WHERE id = 'default-pattern')),
         COALESCE($10, (SELECT id FROM calendars WHERE id = 'default-247')),
         COALESCE($11, false), COALESCE($12, 60))`,
      [
        input.id,
        input.name,
        input.assetType ?? null,
        input.location ?? null,
        input.idealCycleTimeSeconds ?? null,
        input.isActive ?? null,
        placement.areaId ?? input.areaId,
        placement.lineId ?? null,
        input.shiftPatternId ?? null,
        input.calendarId ?? null,
        input.autoOffshiftStatus ?? null,
        input.microStopThresholdSeconds ?? null,
      ],
    );
    const machine = await getMachine(input.id, client);
    if (!machine) throw new Error("INSERT succeeded but the machine could not be read back");
    return machine;
  });
}

export interface MachineChange {
  previous: Machine;
  current: Machine;
  /** Csak a ténylegesen megváltozott mezők — ez kerül az auditba. */
  changes: Record<string, { from: unknown; to: unknown }>;
}

function diff(previous: Machine, current: Machine): MachineChange["changes"] {
  const changes: MachineChange["changes"] = {};
  for (const field of Object.keys(COLUMN_BY_FIELD) as (keyof MachinePatch)[]) {
    if (previous[field] !== current[field]) changes[field] = { from: previous[field], to: current[field] };
  }
  return changes;
}

/**
 * Egy gép módosítása egy tranzakcióban (sor zárolva FOR UPDATE): minden
 * megadott mező egyszerre változik, vagy egyik sem. A régi felületen a
 * törzsadat, az ütemezés és a mikroleállás-küszöb három külön végponton
 * mentődött — egy közbülső hiba félig mentett gépet hagyott.
 */
export async function patchMachineInTransaction(client: PoolClient, id: string, patch: MachinePatch): Promise<MachineChange | undefined> {
  const locked = await client.query(`SELECT 1 FROM machines WHERE id = $1 FOR UPDATE`, [id]);
  if (locked.rowCount === 0) return undefined;
  const previous = (await getMachine(id, client))!;

  const resolved: MachinePatch = { ...patch };
  if (patch.areaId !== undefined || patch.lineId !== undefined) {
    const placement = await resolvePlacement(client, patch, previous);
    if (placement.areaId !== undefined) resolved.areaId = placement.areaId;
    else delete resolved.areaId;
    if (placement.lineId !== undefined) resolved.lineId = placement.lineId;
    else delete resolved.lineId;
  }

  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const [field, value] of Object.entries(resolved) as [keyof MachinePatch, unknown][]) {
    values.push(value);
    sets.push(`${COLUMN_BY_FIELD[field]} = $${values.length}`);
  }
  if (sets.length > 0) {
    await client.query(`UPDATE machines SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, values);
  }
  const current = (await getMachine(id, client))!;
  return { previous, current, changes: diff(previous, current) };
}

export async function patchMachine(id: string, patch: MachinePatch): Promise<MachineChange | undefined> {
  return withTransaction((client) => patchMachineInTransaction(client, id, patch));
}

export class UnknownMachinesError extends Error {
  constructor(readonly ids: string[]) {
    super(`unknown machine(s): ${ids.join(", ")}`);
  }
}

/** Ugyanaz a módosítás több gépen, egy tranzakcióban — vagy mind, vagy egyik sem. */
export async function patchMachines(ids: string[], patch: MachinePatch): Promise<MachineChange[]> {
  return withTransaction(async (client) => {
    const found = await client.query<{ id: string }>(`SELECT id FROM machines WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`, [ids]);
    const known = new Set(found.rows.map((r) => r.id));
    const missing = ids.filter((x) => !known.has(x));
    if (missing.length > 0) throw new UnknownMachinesError(missing);
    const results: MachineChange[] = [];
    // Rendezett sorrend: két párhuzamos tömeges művelet ne zárolja egymást keresztbe.
    for (const machineId of [...ids].sort()) {
      const change = await patchMachineInTransaction(client, machineId, patch);
      if (change) results.push(change);
    }
    return results;
  });
}
