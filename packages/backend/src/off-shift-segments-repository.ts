import { pool } from "./db.js";
import { loadShiftWindows } from "./shift-windows.js";

export interface TimeSegment {
  start: string;
  end: string;
}

/**
 * A [from, to) tartományban visszaadja azokat a szakaszokat, amik a gép
 * naptára ÉS műszakrendje szerint NEM munkaidőre esnek — akár egy teljes
 * nem-munkanap, akár egy műszakok közötti napi rés (pl. egy két műszakos
 * gépnél az éjszakai 22:00-06:00 közötti kiesés). A munkaidő-ablakok a
 * közös shift-windows.ts-ből jönnek (ugyanazok, mint a műszak-összesítőé és
 * a resolve_shift()-é), ezek közötti réseket adjuk vissza.
 */
export async function getOffShiftSegments(machineId: string, from: Date, to: Date): Promise<TimeSegment[]> {
  const exists = await pool.query(`SELECT 1 FROM machines WHERE id = $1`, [machineId]);
  if (exists.rowCount === 0) return [];
  const windows = await loadShiftWindows(from, to, machineId);

  const merged: { start: Date; end: Date }[] = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) {
      if (w.end > last.end) last.end = w.end;
    } else {
      merged.push({ start: w.start, end: w.end });
    }
  }

  const offSegments: TimeSegment[] = [];
  let cursor = new Date(from);
  for (const seg of merged) {
    if (seg.start > cursor) {
      const segEnd = seg.start < to ? seg.start : to;
      offSegments.push({ start: cursor.toISOString(), end: segEnd.toISOString() });
    }
    if (seg.end > cursor) cursor = seg.end;
    if (cursor >= to) break;
  }
  if (cursor < to) {
    offSegments.push({ start: cursor.toISOString(), end: to.toISOString() });
  }

  return offSegments.filter((s) => new Date(s.start) < new Date(s.end));
}
