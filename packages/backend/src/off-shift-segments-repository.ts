import { pool } from "./db.js";

export interface TimeSegment {
  start: string;
  end: string;
}

/**
 * A [from, to) tartományban visszaadja azokat a szakaszokat, amik a gép
 * naptára ÉS műszakrendje szerint NEM munkaidőre esnek — akár egy teljes
 * nem-munkanap, akár egy műszakok közötti napi rés (pl. egy két műszakos
 * gépnél az éjszakai 22:00-06:00 közötti kiesés). A munkaidő-szakaszokat
 * építjük fel elsőként (naponta, a naptár + a műszakrend alapján), majd
 * ezek közötti réseket adjuk vissza.
 */
export async function getOffShiftSegments(machineId: string, from: Date, to: Date): Promise<TimeSegment[]> {
  const machineResult = await pool.query<{ shift_pattern_id: string | null; calendar_id: string | null }>(
    `SELECT shift_pattern_id, calendar_id FROM machines WHERE id = $1`,
    [machineId],
  );
  const machine = machineResult.rows[0];
  if (!machine) return [];

  const shiftsResult = await pool.query<{ name: string; start_time: string; end_time: string }>(
    `SELECT name, start_time, end_time FROM shift_pattern_shifts WHERE shift_pattern_id = $1`,
    [machine.shift_pattern_id],
  );
  const workingDaysResult = await pool.query<{ day_of_week: number; is_working: boolean }>(
    `SELECT day_of_week, is_working FROM calendar_working_days WHERE calendar_id = $1`,
    [machine.calendar_id],
  );
  const workingByDow = new Map<number, boolean>();
  for (const row of workingDaysResult.rows) workingByDow.set(row.day_of_week, row.is_working);

  const onSegments: { start: Date; end: Date }[] = [];
  const dayCursor = new Date(from);
  dayCursor.setHours(0, 0, 0, 0);
  while (dayCursor < to) {
    const dow = dayCursor.getDay();
    const isWorking = workingByDow.get(dow) ?? true;
    if (isWorking) {
      for (const shift of shiftsResult.rows) {
        const [startH, startM] = shift.start_time.split(":").map(Number);
        const [endH, endM] = shift.end_time.split(":").map(Number);
        const shiftStart = new Date(dayCursor);
        shiftStart.setHours(startH ?? 0, startM ?? 0, 0, 0);
        let shiftEnd = new Date(dayCursor);
        shiftEnd.setHours(endH ?? 0, endM ?? 0, 0, 0);
        if (shiftEnd <= shiftStart) shiftEnd = new Date(shiftEnd.getTime() + 24 * 60 * 60 * 1000);
        onSegments.push({ start: shiftStart, end: shiftEnd });
      }
    }
    dayCursor.setDate(dayCursor.getDate() + 1);
  }

  onSegments.sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: { start: Date; end: Date }[] = [];
  for (const seg of onSegments) {
    const last = merged[merged.length - 1];
    if (last && seg.start <= last.end) {
      if (seg.end > last.end) last.end = seg.end;
    } else {
      merged.push({ ...seg });
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