import { randomBytes } from "node:crypto";
import { pool } from "./db.js";

export interface Shift {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
}

export interface ShiftPattern {
  id: string;
  name: string;
  shifts: Shift[];
}

export interface Calendar {
  id: string;
  name: string;
  workingDays: boolean[]; // index 0=vasárnap ... 6=szombat
}

function newId(): string {
  return randomBytes(12).toString("hex");
}

// --- Shift patterns ---

export async function listShiftPatterns(): Promise<ShiftPattern[]> {
  const patternsResult = await pool.query<{ id: string; name: string }>(`SELECT * FROM shift_patterns ORDER BY name`);
  const shiftsResult = await pool.query<{ id: string; shift_pattern_id: string; name: string; start_time: string; end_time: string }>(
    `SELECT * FROM shift_pattern_shifts ORDER BY start_time`,
  );
  const shiftsByPattern = new Map<string, Shift[]>();
  for (const row of shiftsResult.rows) {
    const list = shiftsByPattern.get(row.shift_pattern_id) ?? [];
    list.push({ id: row.id, name: row.name, startTime: row.start_time, endTime: row.end_time });
    shiftsByPattern.set(row.shift_pattern_id, list);
  }
  return patternsResult.rows.map((p) => ({ id: p.id, name: p.name, shifts: shiftsByPattern.get(p.id) ?? [] }));
}

export async function createShiftPattern(name: string): Promise<ShiftPattern> {
  const id = newId();
  await pool.query(`INSERT INTO shift_patterns (id, name) VALUES ($1, $2)`, [id, name]);
  return { id, name, shifts: [] };
}

export async function deleteShiftPattern(id: string): Promise<boolean> {
  const result = await pool.query(`DELETE FROM shift_patterns WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export interface AddShiftInput {
  name: string;
  startTime: string;
  endTime: string;
}

export async function addShiftToPattern(patternId: string, input: AddShiftInput): Promise<Shift> {
  const id = newId();
  await pool.query(
    `INSERT INTO shift_pattern_shifts (id, shift_pattern_id, name, start_time, end_time) VALUES ($1, $2, $3, $4, $5)`,
    [id, patternId, input.name, input.startTime, input.endTime],
  );
  return { id, ...input };
}

export async function deleteShift(shiftId: string): Promise<boolean> {
  const result = await pool.query(`DELETE FROM shift_pattern_shifts WHERE id = $1`, [shiftId]);
  return (result.rowCount ?? 0) > 0;
}

// --- Calendars ---

export async function listCalendars(): Promise<Calendar[]> {
  const calendarsResult = await pool.query<{ id: string; name: string }>(`SELECT * FROM calendars ORDER BY name`);
  const daysResult = await pool.query<{ calendar_id: string; day_of_week: number; is_working: boolean }>(
    `SELECT * FROM calendar_working_days`,
  );
  const daysByCalendar = new Map<string, boolean[]>();
  for (const row of daysResult.rows) {
    const days = daysByCalendar.get(row.calendar_id) ?? [true, true, true, true, true, true, true];
    days[row.day_of_week] = row.is_working;
    daysByCalendar.set(row.calendar_id, days);
  }
  return calendarsResult.rows.map((c) => ({
    id: c.id,
    name: c.name,
    workingDays: daysByCalendar.get(c.id) ?? [true, true, true, true, true, true, true],
  }));
}

export async function createCalendar(name: string, workingDays: boolean[]): Promise<Calendar> {
  const id = newId();
  await pool.query(`INSERT INTO calendars (id, name) VALUES ($1, $2)`, [id, name]);
  for (let day = 0; day < 7; day++) {
    await pool.query(
      `INSERT INTO calendar_working_days (calendar_id, day_of_week, is_working) VALUES ($1, $2, $3)`,
      [id, day, workingDays[day] ?? true],
    );
  }
  return { id, name, workingDays };
}

export async function updateCalendarWorkingDays(calendarId: string, workingDays: boolean[]): Promise<void> {
  for (let day = 0; day < 7; day++) {
    await pool.query(
      `INSERT INTO calendar_working_days (calendar_id, day_of_week, is_working)
       VALUES ($1, $2, $3)
       ON CONFLICT (calendar_id, day_of_week) DO UPDATE SET is_working = EXCLUDED.is_working`,
      [calendarId, day, workingDays[day] ?? true],
    );
  }
}

export async function deleteCalendar(id: string): Promise<boolean> {
  const result = await pool.query(`DELETE FROM calendars WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

// --- Machine assignment ---

export async function assignMachineScheduling(
  machineId: string,
  input: { shiftPatternId?: string; calendarId?: string; autoOffshiftStatus?: boolean },
): Promise<void> {
  await pool.query(
    `UPDATE machines SET
       shift_pattern_id = COALESCE($2, shift_pattern_id),
       calendar_id = COALESCE($3, calendar_id),
       auto_offshift_status = COALESCE($4, auto_offshift_status)
     WHERE id = $1`,
    [machineId, input.shiftPatternId ?? null, input.calendarId ?? null, input.autoOffshiftStatus ?? null],
  );
}