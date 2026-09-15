import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

export interface TerminalUi {
  id: string;
  name: string;
  machineIds: string[];
  machineNames: string[];
  createdAt: string;
}

type ListRow = { id: string; name: string; created_at: string; machine_ids: string[]; machine_names: string[] };

function toTerminalUi(row: ListRow): TerminalUi {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    machineIds: row.machine_ids,
    machineNames: row.machine_names,
  };
}

// LEFT JOIN + array_agg: egy terminál UI-hoz tartozó összes gép egy sorba
// összegyűjtve, még akkor is, ha egyetlen gép sincs hozzárendelve (üres
// tömb, nem hiányzó sor).
const BASE_SELECT = `
  SELECT t.id, t.name, t.created_at,
         COALESCE(array_agg(m.id) FILTER (WHERE m.id IS NOT NULL), '{}') AS machine_ids,
         COALESCE(array_agg(m.name) FILTER (WHERE m.id IS NOT NULL), '{}') AS machine_names
  FROM terminal_uis t
  LEFT JOIN terminal_ui_machines tum ON tum.terminal_ui_id = t.id
  LEFT JOIN machines m ON m.id = tum.machine_id
`;

export async function listTerminalUis(): Promise<TerminalUi[]> {
  const result = await pool.query<ListRow>(`${BASE_SELECT} GROUP BY t.id, t.name, t.created_at ORDER BY t.name`);
  return result.rows.map(toTerminalUi);
}

export async function getTerminalUi(id: string): Promise<TerminalUi | undefined> {
  const result = await pool.query<ListRow>(
    `${BASE_SELECT} WHERE t.id = $1 GROUP BY t.id, t.name, t.created_at`,
    [id],
  );
  return result.rows[0] ? toTerminalUi(result.rows[0]) : undefined;
}

/**
 * A terminál UI és a hozzá tartozó gép-lista egy tranzakcióban jön létre:
 * ha a gép-hozzárendelések beszúrása közben bármi elszáll, az egész
 * (fél)kész terminál UI se maradjon az adatbázisban.
 */
export async function createTerminalUi(name: string, machineIds: string[]): Promise<TerminalUi> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const id = randomUUID();
    await client.query(`INSERT INTO terminal_uis (id, name) VALUES ($1, $2)`, [id, name]);
    for (const machineId of machineIds) {
      await client.query(`INSERT INTO terminal_ui_machines (terminal_ui_id, machine_id) VALUES ($1, $2)`, [
        id,
        machineId,
      ]);
    }
    await client.query("COMMIT");
    const result = await getTerminalUi(id);
    if (!result) throw new Error("failed to load newly created terminal UI");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface UpdateTerminalUiInput {
  name?: string;
  machineIds?: string[];
}

export async function updateTerminalUi(id: string, input: UpdateTerminalUiInput): Promise<TerminalUi | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (input.name) {
      await client.query(`UPDATE terminal_uis SET name = $2 WHERE id = $1`, [id, input.name]);
    }
    if (input.machineIds) {
      // Teljes csere: töröljük a régi hozzárendeléseket, beszúrjuk az újakat.
      await client.query(`DELETE FROM terminal_ui_machines WHERE terminal_ui_id = $1`, [id]);
      for (const machineId of input.machineIds) {
        await client.query(`INSERT INTO terminal_ui_machines (terminal_ui_id, machine_id) VALUES ($1, $2)`, [
          id,
          machineId,
        ]);
      }
    }
    await client.query("COMMIT");
    return await getTerminalUi(id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteTerminalUi(id: string): Promise<boolean> {
  const result = await pool.query(`DELETE FROM terminal_uis WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}