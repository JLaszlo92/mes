import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

/**
 * Üzemi hierarchia: telephely → részleg → gyártósor (036). Az elemek
 * azonosítója generált UUID — nem felhasználói adat, a név szabadon
 * átnevezhető. Törlés csak üres elemre (ON DELETE RESTRICT → 23503 → 409).
 */

export type HierarchyLevel = "site" | "area" | "line";

export interface Site {
  id: string;
  name: string;
  areaCount: number;
  machineCount: number;
}
export interface Area {
  id: string;
  siteId: string;
  name: string;
  lineCount: number;
  machineCount: number;
}
export interface Line {
  id: string;
  areaId: string;
  name: string;
  machineCount: number;
}

export interface PlantHierarchy {
  sites: Site[];
  areas: Area[];
  lines: Line[];
}

export async function getPlantHierarchy(): Promise<PlantHierarchy> {
  const [sites, areas, lines] = await Promise.all([
    pool.query<{ id: string; name: string; area_count: string; machine_count: string }>(
      `SELECT s.id, s.name,
              (SELECT count(*) FROM areas a WHERE a.site_id = s.id) AS area_count,
              (SELECT count(*) FROM machines m JOIN areas a ON a.id = m.area_id WHERE a.site_id = s.id) AS machine_count
       FROM sites s ORDER BY lower(s.name)`,
    ),
    pool.query<{ id: string; site_id: string; name: string; line_count: string; machine_count: string }>(
      `SELECT a.id, a.site_id, a.name,
              (SELECT count(*) FROM lines l WHERE l.area_id = a.id) AS line_count,
              (SELECT count(*) FROM machines m WHERE m.area_id = a.id) AS machine_count
       FROM areas a ORDER BY lower(a.name)`,
    ),
    pool.query<{ id: string; area_id: string; name: string; machine_count: string }>(
      `SELECT l.id, l.area_id, l.name,
              (SELECT count(*) FROM machines m WHERE m.line_id = l.id) AS machine_count
       FROM lines l ORDER BY lower(l.name)`,
    ),
  ]);
  return {
    sites: sites.rows.map((r) => ({ id: r.id, name: r.name, areaCount: Number(r.area_count), machineCount: Number(r.machine_count) })),
    areas: areas.rows.map((r) => ({
      id: r.id,
      siteId: r.site_id,
      name: r.name,
      lineCount: Number(r.line_count),
      machineCount: Number(r.machine_count),
    })),
    lines: lines.rows.map((r) => ({ id: r.id, areaId: r.area_id, name: r.name, machineCount: Number(r.machine_count) })),
  };
}

const TABLE: Record<HierarchyLevel, { table: string; parentColumn: string | null }> = {
  site: { table: "sites", parentColumn: null },
  area: { table: "areas", parentColumn: "site_id" },
  line: { table: "lines", parentColumn: "area_id" },
};

export interface HierarchyNode {
  id: string;
  name: string;
  parentId: string | null;
}

export async function createHierarchyNode(level: HierarchyLevel, name: string, parentId: string | null): Promise<HierarchyNode> {
  const { table, parentColumn } = TABLE[level];
  const id = randomUUID();
  if (parentColumn) {
    await pool.query(`INSERT INTO ${table} (id, ${parentColumn}, name) VALUES ($1, $2, $3)`, [id, parentId, name]);
  } else {
    await pool.query(`INSERT INTO ${table} (id, name) VALUES ($1, $2)`, [id, name]);
  }
  return { id, name, parentId };
}

/** Előző és új állapot az audithoz; undefined, ha nincs ilyen elem. */
export async function updateHierarchyNode(
  level: HierarchyLevel,
  id: string,
  changes: { name?: string; parentId?: string },
): Promise<{ previous: HierarchyNode; current: HierarchyNode } | undefined> {
  const { table, parentColumn } = TABLE[level];
  const parentSelect = parentColumn ? `${parentColumn}` : "NULL::text";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await client.query<{ id: string; name: string; parent_id: string | null }>(
      `SELECT id, name, ${parentSelect} AS parent_id FROM ${table} WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = before.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return undefined;
    }
    const name = changes.name ?? row.name;
    const parentId = parentColumn ? changes.parentId ?? row.parent_id : null;
    if (parentColumn) {
      // Egy sor áthelyezése másik részlegbe a gépeit is viszi (036: ON UPDATE CASCADE).
      await client.query(`UPDATE ${table} SET name = $2, ${parentColumn} = $3, updated_at = now() WHERE id = $1`, [id, name, parentId]);
    } else {
      await client.query(`UPDATE ${table} SET name = $2, updated_at = now() WHERE id = $1`, [id, name]);
    }
    await client.query("COMMIT");
    return { previous: { id, name: row.name, parentId: row.parent_id }, current: { id, name, parentId } };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteHierarchyNode(level: HierarchyLevel, id: string): Promise<HierarchyNode | undefined> {
  const { table, parentColumn } = TABLE[level];
  const result = await pool.query<{ id: string; name: string; parent_id: string | null }>(
    `DELETE FROM ${table} WHERE id = $1 RETURNING id, name, ${parentColumn ?? "NULL::text"} AS parent_id`,
    [id],
  );
  const row = result.rows[0];
  return row ? { id: row.id, name: row.name, parentId: row.parent_id } : undefined;
}
