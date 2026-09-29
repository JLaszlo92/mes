import { getOffShiftSegments } from "./off-shift-segments-repository.js";

/**
 * A Gantt ütemező szegmentálási logikája — szerveroldalon, hogy egyetlen
 * hiteles helyen éljen. Korábban a frontend `computeSegments` függvénye
 * számolta, és a szegmenseket egyenként, nem atomikusan POST-olta; egy
 * félúton elhasaló sorozat félig ütemezett munkarendelést hagyott maga után.
 *
 * Két mód:
 *  - "duration": adott kezdéstől adott mennyiségű *munkaidőt* foglal le, a
 *    műszakszüneteket átugorva (új ledobás a poolból, teljes rendelés mozgatása).
 *  - "span": egy falióra szerinti [start, end] intervallumon belüli összes
 *    munkaidőt foglalja le (átméretezés — a bar szélét egy konkrét időpontra
 *    húzza a felhasználó).
 *
 * A munkaidő forrása ugyanaz az off-shift-segments lekérdezés, amiből a Gantt
 * a műszakon kívüli sávokat árnyékolja, így amit a felhasználó lát, és amit a
 * szerver elfogad, nem térhet el egymástól.
 */

export interface TimeRange {
  start: Date;
  end: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Egy munkarendelés legfeljebb ekkora időt foglalhat (munkaidőben és falióra szerint is). */
export const MAX_SCHEDULE_MS = 60 * DAY_MS;

/** Ennyivel néz előre a "duration" mód a kért munkaidőn túl, hogy a szünetek is beleférjenek. */
export const LOOKAHEAD_MS = 30 * DAY_MS;

/**
 * A [from, to) intervallum munkaidős részei, a műszakon kívüli szegmensek
 * kivonásával. Az off-shift szegmensek lehetnek rendezetlenek, és átnyúlhatnak
 * az intervallum határain.
 */
export function workingIntervals(from: Date, to: Date, offShift: TimeRange[]): TimeRange[] {
  const toMs = to.getTime();
  const sorted = offShift
    .filter((s) => s.end.getTime() > s.start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const result: TimeRange[] = [];
  let cursor = from.getTime();
  for (const off of sorted) {
    if (cursor >= toMs) break;
    const offStart = off.start.getTime();
    const offEnd = off.end.getTime();
    if (offEnd <= cursor) continue;
    if (offStart >= toMs) break;
    if (offStart > cursor) result.push({ start: new Date(cursor), end: new Date(offStart) });
    cursor = Math.max(cursor, offEnd);
  }
  if (cursor < toMs) result.push({ start: new Date(cursor), end: new Date(toMs) });
  return result;
}

/** `durationMs` munkaidő lefoglalása `start`-tól, legfeljebb `horizonEnd`-ig. */
export function chunksForDuration(
  start: Date,
  durationMs: number,
  offShift: TimeRange[],
  horizonEnd: Date,
): TimeRange[] {
  const chunks: TimeRange[] = [];
  let remaining = durationMs;
  for (const interval of workingIntervals(start, horizonEnd, offShift)) {
    if (remaining <= 0) break;
    const length = interval.end.getTime() - interval.start.getTime();
    const used = Math.min(length, remaining);
    chunks.push({ start: interval.start, end: new Date(interval.start.getTime() + used) });
    remaining -= used;
  }
  return chunks;
}

export function totalDurationMs(ranges: TimeRange[]): number {
  return ranges.reduce((sum, r) => sum + (r.end.getTime() - r.start.getTime()), 0);
}

export type SchedulePlanRequest =
  | { mode: "duration"; start: Date; durationMs: number }
  | { mode: "span"; start: Date; end: Date };

export type SchedulePlanResult = { ok: true; chunks: TimeRange[] } | { ok: false; error: string };

async function loadOffShift(machineId: string, from: Date, to: Date): Promise<TimeRange[]> {
  const segments = await getOffShiftSegments(machineId, from, to);
  return segments.map((s: { start: string | Date; end: string | Date }) => ({
    start: new Date(s.start),
    end: new Date(s.end),
  }));
}

export async function planScheduleChunks(machineId: string, request: SchedulePlanRequest): Promise<SchedulePlanResult> {
  if (request.mode === "span") {
    const offShift = await loadOffShift(machineId, request.start, request.end);
    const chunks = workingIntervals(request.start, request.end, offShift);
    if (chunks.length === 0) {
      return { ok: false, error: "the selected time span contains no working time on this machine" };
    }
    return { ok: true, chunks };
  }

  const horizonEnd = new Date(request.start.getTime() + request.durationMs + LOOKAHEAD_MS);
  const offShift = await loadOffShift(machineId, request.start, horizonEnd);
  const chunks = chunksForDuration(request.start, request.durationMs, offShift, horizonEnd);
  if (chunks.length === 0 || totalDurationMs(chunks) < request.durationMs) {
    return {
      ok: false,
      error: "not enough working time on this machine to fit this order (checked 30 days past the required duration)",
    };
  }
  return { ok: true, chunks };
}
