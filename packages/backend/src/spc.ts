/**
 * SPC — tiszta számítások (adatbázis nélkül).
 *
 * A mérések egyedi értékek (egy ellenőrzés = egy darab, alcsoport-méret 1),
 * ezért I-MR kártya (egyedi érték + mozgó terjedelem):
 *   σ_within  = MR̄ / d2,   d2 = 1.128 (n = 2)
 *   UCL / LCL = x̄ ± 3·σ_within   (= x̄ ± 2.66·MR̄)
 *   MR UCL    = D4 · MR̄,   D4 = 3.267
 * Képesség:
 *   Cp  = (USL − LSL) / 6σ_within        Cpk = min(USL − x̄, x̄ − LSL) / 3σ_within
 *   Pp  = (USL − LSL) / 6σ_overall       Ppk = ugyanígy σ_overall-lal (mintabeli szórás)
 *   Egyoldali tűrésnél Cp / Pp nincs, Cpk / Ppk az egy oldalra számol.
 * Jelzések (a Nelson / Western Electric szabályokból a három leggyakoribb):
 *   beyond — a pont a beavatkozási határon kívül van (> 3σ)
 *   run    — 7 egymást követő pont a középvonal ugyanazon oldalán
 *   trend  — 6 egymást követő pont folyamatosan nő vagy csökken
 */

export const D2 = 1.128;
export const D4 = 3.267;
export const RUN_LENGTH = 7;
export const TREND_LENGTH = 6;
/** Below this many values capability indices are shown but marked as uncertain. */
export const MIN_RELIABLE_N = 25;

export interface ImrStats {
  n: number;
  mean: number;
  /** Sample standard deviation (n − 1). */
  sigmaOverall: number | null;
  mrBar: number | null;
  sigmaWithin: number | null;
  ucl: number | null;
  lcl: number | null;
  mrUcl: number | null;
}

export function imrStats(values: readonly number[]): ImrStats | null {
  const n = values.length;
  if (n === 0) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sigmaOverall = n > 1 ? Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : null;
  if (n < 2) return { n, mean, sigmaOverall, mrBar: null, sigmaWithin: null, ucl: null, lcl: null, mrUcl: null };
  let mrSum = 0;
  for (let i = 1; i < n; i++) mrSum += Math.abs(values[i]! - values[i - 1]!);
  const mrBar = mrSum / (n - 1);
  const sigmaWithin = mrBar / D2;
  return { n, mean, sigmaOverall, mrBar, sigmaWithin, ucl: mean + 3 * sigmaWithin, lcl: mean - 3 * sigmaWithin, mrUcl: D4 * mrBar };
}

/** Moving ranges: the first point has none. */
export function movingRanges(values: readonly number[]): (number | null)[] {
  return values.map((v, i) => (i === 0 ? null : Math.abs(v - values[i - 1]!)));
}

export interface Capability {
  cp: number | null;
  cpk: number | null;
  pp: number | null;
  ppk: number | null;
}

function indices(mean: number, sigma: number | null, lsl: number | null, usl: number | null): { p: number | null; pk: number | null } {
  if (sigma === null || !(sigma > 0)) return { p: null, pk: null };
  const p = lsl !== null && usl !== null ? (usl - lsl) / (6 * sigma) : null;
  const upper = usl !== null ? (usl - mean) / (3 * sigma) : null;
  const lower = lsl !== null ? (mean - lsl) / (3 * sigma) : null;
  const pk = upper !== null && lower !== null ? Math.min(upper, lower) : (upper ?? lower);
  return { p, pk };
}

export function capability(stats: Pick<ImrStats, "mean" | "sigmaWithin" | "sigmaOverall">, lsl: number | null, usl: number | null): Capability {
  const within = indices(stats.mean, stats.sigmaWithin, lsl, usl);
  const overall = indices(stats.mean, stats.sigmaOverall, lsl, usl);
  return { cp: within.p, cpk: within.pk, pp: overall.p, ppk: overall.pk };
}

export type SignalRule = "beyond" | "run" | "trend";

/** For every point the rules it breaks (empty if none). A run or trend flags every point of it. */
export function signals(values: readonly number[], stats: Pick<ImrStats, "mean" | "ucl" | "lcl"> | null): SignalRule[][] {
  const out: SignalRule[][] = values.map(() => []);
  if (!stats || stats.ucl === null || stats.lcl === null) return out;
  const add = (i: number, r: SignalRule) => {
    if (!out[i]!.includes(r)) out[i]!.push(r);
  };
  values.forEach((v, i) => {
    if (v > stats.ucl! || v < stats.lcl!) add(i, "beyond");
  });
  // Run: same side of the centre line (a point exactly on it breaks the run).
  let start = 0;
  for (let i = 1; i <= values.length; i++) {
    const side = (k: number) => Math.sign(values[k]! - stats.mean);
    const broken = i === values.length || side(i) === 0 || side(i) !== side(start);
    if (broken) {
      if (side(start) !== 0 && i - start >= RUN_LENGTH) for (let k = start; k < i; k++) add(k, "run");
      start = i;
    }
  }
  // Trend: strictly increasing or decreasing.
  for (const dir of [1, -1]) {
    let s = 0;
    for (let i = 1; i <= values.length; i++) {
      const continues = i < values.length && Math.sign(values[i]! - values[i - 1]!) === dir;
      if (!continues) {
        if (i - s >= TREND_LENGTH) for (let k = s; k < i; k++) add(k, "trend");
        s = i;
      }
    }
  }
  return out;
}

export type CapabilityGrade = "capable" | "marginal" | "not_capable" | "unknown";

/** The usual thresholds: Cpk ≥ 1.33 capable, 1.00–1.33 marginal, below 1.00 not capable. */
export function grade(cpk: number | null): CapabilityGrade {
  if (cpk === null || !Number.isFinite(cpk)) return "unknown";
  return cpk >= 1.33 ? "capable" : cpk >= 1 ? "marginal" : "not_capable";
}
