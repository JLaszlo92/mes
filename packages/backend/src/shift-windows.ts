import { pool } from "./db.js";

/**
 * Műszakablakok generálása: minden gép minden műszakjának konkrét
 * [start, end) időablaka egy időszakban, a gyár helyi idejében
 * (config.timezone → process.env.TZ).
 *
 * Pontosan a resolve_shift() (sql/024) szabályait követi, hogy a Gantt,
 * az ütemezés és a műszak-összesítő ugyanazt tekintse műszaknak:
 *  - egy műszak a KEZDŐNAPJÁHOZ tartozik (shiftDate), az éjszakai műszak
 *    (end <= start) másnap ér véget;
 *  - a naptár (calendar_working_days) a kezdőnap alapján dönt; hiányzó nap =
 *    munkanap;
 *  - a generálás az időszak ELŐTTI naptól indul, hogy az előző este
 *    kezdődött éjszakai műszak is benne legyen (korábban kimaradt, így
 *    éjfél és 06:00 között minden háromműszakos gép műszakon kívülinek
 *    látszott a Ganttban és az ütemezésben);
 *  - napokat naptár szerint léptet (setDate), nem 24 órával, így a
 *    DST-váltás napján is helyes.
 */

export interface ShiftWindow {
  machineId: string;
  /** A műszak kezdőnapja, helyi idő szerint: YYYY-MM-DD. */
  shiftDate: string;
  shiftName: string;
  start: Date;
  end: Date;
}

function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function atTime(day: Date, time: string): Date {
  const [h, m, s] = time.split(":").map(Number);
  const d = new Date(day);
  d.setHours(h ?? 0, m ?? 0, s ?? 0, 0);
  return d;
}

/** Az összes (vagy egy) gép műszakablakai, amelyek átfednek a [from, to) időszakkal, kezdés szerint rendezve. */
export async function loadShiftWindows(from: Date, to: Date, machineId?: string): Promise<ShiftWindow[]> {
  const machines = await pool.query<{ id: string; shift_pattern_id: string | null; calendar_id: string | null }>(
    `SELECT id, shift_pattern_id, calendar_id FROM machines WHERE ($1::text IS NULL OR id = $1)`,
    [machineId ?? null],
  );
  if (machines.rows.length === 0) return [];

  const shifts = await pool.query<{ shift_pattern_id: string; name: string; start_time: string; end_time: string }>(
    `SELECT shift_pattern_id, name, start_time::text, end_time::text FROM shift_pattern_shifts
     WHERE shift_pattern_id = ANY($1::text[])`,
    [[...new Set(machines.rows.map((m) => m.shift_pattern_id).filter((x): x is string => !!x))]],
  );
  const days = await pool.query<{ calendar_id: string; day_of_week: number; is_working: boolean }>(
    `SELECT calendar_id, day_of_week, is_working FROM calendar_working_days WHERE calendar_id = ANY($1::text[])`,
    [[...new Set(machines.rows.map((m) => m.calendar_id).filter((x): x is string => !!x))]],
  );

  const shiftsByPattern = new Map<string, { name: string; start_time: string; end_time: string }[]>();
  for (const s of shifts.rows) {
    const list = shiftsByPattern.get(s.shift_pattern_id) ?? [];
    list.push(s);
    shiftsByPattern.set(s.shift_pattern_id, list);
  }
  const workingByCalendar = new Map<string, Map<number, boolean>>();
  for (const d of days.rows) {
    const map = workingByCalendar.get(d.calendar_id) ?? new Map<number, boolean>();
    map.set(d.day_of_week, d.is_working);
    workingByCalendar.set(d.calendar_id, map);
  }

  const windows: ShiftWindow[] = [];
  const firstDay = new Date(from);
  firstDay.setHours(0, 0, 0, 0);
  firstDay.setDate(firstDay.getDate() - 1);

  for (const m of machines.rows) {
    const patternShifts = m.shift_pattern_id ? shiftsByPattern.get(m.shift_pattern_id) ?? [] : [];
    const working = m.calendar_id ? workingByCalendar.get(m.calendar_id) : undefined;
    for (const day = new Date(firstDay); day < to; day.setDate(day.getDate() + 1)) {
      if (!(working?.get(day.getDay()) ?? true)) continue;
      for (const s of patternShifts) {
        const start = atTime(day, s.start_time);
        let end: Date;
        if (s.end_time > s.start_time) {
          end = atTime(day, s.end_time);
        } else {
          const next = new Date(day);
          next.setDate(next.getDate() + 1);
          end = atTime(next, s.end_time);
        }
        if (end > from && start < to) {
          windows.push({ machineId: m.id, shiftDate: localDateString(day), shiftName: s.name, start, end });
        }
      }
    }
  }
  windows.sort((a, b) => a.start.getTime() - b.start.getTime() || a.machineId.localeCompare(b.machineId));
  return windows;
}

export { localDateString };
