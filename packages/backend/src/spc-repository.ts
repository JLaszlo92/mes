import { pool } from "./db.js";
import type { CheckKind } from "./quality-input.js";
import { capability, grade, imrStats, MIN_RELIABLE_N, movingRanges, signals, type Capability, type CapabilityGrade, type ImrStats, type SignalRule } from "./spc.js";

/**
 * SPC adatok a rögzített mérésekből. Egy "jellemző" itt part + mérés neve
 * (a terv verziói között a jellemző azonosítója változik, a neve nem). A
 * képességhez a part aktuális tervének határai számítanak; ha a jellemző már
 * nincs a tervben, az utolsó mérés idején érvényes határok.
 */

export interface SpcFilter {
  from: Date;
  to?: Date;
  machineIds?: string[];
  kinds?: CheckKind[];
  /** "first": only the first attempt of a measurement in a check (re-measurements left out). */
  attempts: "all" | "first";
}

type Row = {
  id: string;
  value: string;
  passed: boolean;
  lower_limit: string | null;
  upper_limit: string | null;
  nominal: string | null;
  unit: string | null;
  attempt: number;
  measured_at: Date;
  measured_by_name: string | null;
  name: string;
  check_id: string;
  kind: CheckKind;
  work_order_id: string;
  order_number: string;
  part_name: string;
  machine_name: string | null;
};

const num = (v: string | null) => (v === null ? null : Number(v));

async function rows(f: SpcFilter, only?: { partName: string; name: string }, limit = 200_000, newestFirst = false): Promise<Row[]> {
  const where = [`qm.kind = 'variable'`, `qm.measured_at >= $1`];
  const args: unknown[] = [f.from];
  const arg = (v: unknown) => {
    args.push(v);
    return `$${args.length}`;
  };
  if (f.to) where.push(`qm.measured_at < ${arg(f.to)}`);
  if (f.machineIds) where.push(`qc.machine_id = ANY(${arg(f.machineIds)})`);
  if (f.kinds?.length) where.push(`qc.kind = ANY(${arg(f.kinds)})`);
  if (f.attempts === "first") where.push(`qm.attempt = 1`);
  if (only) where.push(`wo.part_name = ${arg(only.partName)} AND qm.name = ${arg(only.name)}`);
  const result = await pool.query<Row>(
    `SELECT qm.id, qm.value, qm.passed, qm.lower_limit, qm.upper_limit, qm.nominal, qm.unit, qm.attempt, qm.measured_at, qm.measured_by_name, qm.name,
            qc.id AS check_id, qc.kind, wo.id AS work_order_id, wo.order_number, wo.part_name, m.name AS machine_name
     FROM quality_measurements qm
     JOIN quality_checks qc ON qc.id = qm.check_id
     JOIN work_orders wo ON wo.id = qc.work_order_id
     LEFT JOIN machines m ON m.id = qc.machine_id
     WHERE ${where.join(" AND ")}
     ORDER BY qm.measured_at ${newestFirst ? "DESC" : "ASC"}, qm.id
     LIMIT ${arg(limit)}`,
    args,
  );
  return newestFirst ? result.rows.reverse() : result.rows;
}

/** The limits capability is judged against: the part's current plan, else the latest measurement's. */
async function currentLimits(partName: string, name: string): Promise<{ lsl: number | null; usl: number | null; nominal: number | null; unit: string | null; planVersion: number } | null> {
  const result = await pool.query<{ lower_limit: string | null; upper_limit: string | null; nominal: string | null; unit: string | null; version: number }>(
    `SELECT c.lower_limit, c.upper_limit, c.nominal, c.unit, p.version FROM quality_characteristics c JOIN quality_plans p ON p.id = c.plan_id
     WHERE p.part_name = $1 AND p.is_current AND c.name = $2 AND c.kind = 'variable' ORDER BY c.seq LIMIT 1`,
    [partName, name],
  );
  const r = result.rows[0];
  return r ? { lsl: num(r.lower_limit), usl: num(r.upper_limit), nominal: num(r.nominal), unit: r.unit, planVersion: r.version } : null;
}

const lowerOf = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));

export interface SpcSummary {
  partName: string;
  name: string;
  unit: string | null;
  lsl: number | null;
  usl: number | null;
  nominal: number | null;
  n: number;
  mean: number | null;
  sigmaWithin: number | null;
  sigmaOverall: number | null;
  capability: Capability;
  /**
   * Judged on the lower of Cpk and Ppk: a drifting process can have a good Cpk (short-term spread) and still make
   * bad parts, which Ppk (overall spread) shows.
   */
  grade: CapabilityGrade;
  /** No control rule broken in the period; without it the capability indices only describe the past. */
  stable: boolean;
  reliable: boolean;
  outOfSpec: number;
  signalPoints: number;
  lastValue: number | null;
  lastAt: string | null;
}

function summarize(partName: string, name: string, list: Row[], limits: Awaited<ReturnType<typeof currentLimits>>): SpcSummary {
  const values = list.map((r) => Number(r.value));
  const last = list.at(-1)!;
  const lsl = limits ? limits.lsl : num(last.lower_limit);
  const usl = limits ? limits.usl : num(last.upper_limit);
  const stats = imrStats(values);
  const cap = stats ? capability(stats, lsl, usl) : { cp: null, cpk: null, pp: null, ppk: null };
  const sig = signals(values, stats);
  return {
    partName,
    name,
    unit: limits?.unit ?? last.unit,
    lsl,
    usl,
    nominal: limits ? limits.nominal : num(last.nominal),
    n: values.length,
    mean: stats?.mean ?? null,
    sigmaWithin: stats?.sigmaWithin ?? null,
    sigmaOverall: stats?.sigmaOverall ?? null,
    capability: cap,
    grade: grade(lowerOf(cap.cpk, cap.ppk)),
    stable: sig.every((s) => s.length === 0),
    reliable: values.length >= MIN_RELIABLE_N,
    outOfSpec: list.filter((r) => !r.passed).length,
    signalPoints: sig.filter((s) => s.length > 0).length,
    lastValue: values.at(-1) ?? null,
    lastAt: last.measured_at.toISOString(),
  };
}

/** One row per measured characteristic (part + measurement name) in the period. */
export async function spcSummary(f: SpcFilter): Promise<SpcSummary[]> {
  const all = await rows(f);
  const groups = new Map<string, Row[]>();
  for (const r of all) {
    const key = `${r.part_name}\u0000${r.name}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const out: SpcSummary[] = [];
  for (const [key, list] of groups) {
    const [partName, name] = key.split("\u0000") as [string, string];
    out.push(summarize(partName, name, list, await currentLimits(partName, name)));
  }
  return out.sort((a, b) => a.partName.localeCompare(b.partName) || a.name.localeCompare(b.name));
}

export const MAX_SERIES_POINTS = 1000;

export interface SpcPoint {
  id: string;
  at: string;
  value: number;
  mr: number | null;
  passed: boolean;
  lsl: number | null;
  usl: number | null;
  attempt: number;
  kind: CheckKind;
  checkId: string;
  workOrderId: string;
  orderNumber: string;
  machineName: string | null;
  measuredByName: string | null;
  signals: SignalRule[];
}

export interface SpcSeries {
  summary: SpcSummary;
  stats: ImrStats;
  points: SpcPoint[];
  /** More points were measured in the period than are shown (the latest MAX_SERIES_POINTS). */
  truncated: boolean;
  /** Some points were measured against other limits than the current ones (the plan changed). */
  limitsChanged: boolean;
  planVersion: number | null;
}

export async function spcSeries(f: SpcFilter, partName: string, name: string): Promise<SpcSeries | null> {
  const list = await rows(f, { partName, name }, MAX_SERIES_POINTS + 1, true);
  if (list.length === 0) return null;
  const truncated = list.length > MAX_SERIES_POINTS;
  if (truncated) list.shift();
  const limits = await currentLimits(partName, name);
  const summary = summarize(partName, name, list, limits);
  const values = list.map((r) => Number(r.value));
  const stats = imrStats(values)!;
  const sig = signals(values, stats);
  const mrs = movingRanges(values);
  const points = list.map((r, i) => ({
    id: r.id,
    at: r.measured_at.toISOString(),
    value: values[i]!,
    mr: mrs[i]!,
    passed: r.passed,
    lsl: num(r.lower_limit),
    usl: num(r.upper_limit),
    attempt: r.attempt,
    kind: r.kind,
    checkId: r.check_id,
    workOrderId: r.work_order_id,
    orderNumber: r.order_number,
    machineName: r.machine_name,
    measuredByName: r.measured_by_name,
    signals: sig[i]!,
  }));
  const limitsChanged = points.some((p) => p.lsl !== summary.lsl || p.usl !== summary.usl);
  return { summary, stats, points, truncated, limitsChanged, planVersion: limits?.planVersion ?? null };
}
