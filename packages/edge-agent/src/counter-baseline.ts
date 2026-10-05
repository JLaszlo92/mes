import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { planCatchup, type CatchupPlan, type CounterSnapshot, type StoredCounters } from "./catchup.js";

export function parseStoredCounters(raw: string): StoredCounters | null {
  try {
    const v = JSON.parse(raw) as Partial<StoredCounters>;
    const ok = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
    if (ok(v.good) && ok(v.scrap) && ok(v.seenAtMs)) return { good: v.good, scrap: v.scrap, seenAtMs: v.seenAtMs };
  } catch {
    // a corrupt file is treated like a missing one
  }
  return null;
}

export function loadCounters(filePath: string): StoredCounters | null {
  try {
    return parseStoredCounters(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** Atomic: write a temp file next to it, then rename over the target. */
export function saveCounters(filePath: string, state: StoredCounters): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, filePath);
}

export interface BaselineLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface CounterBaselineOptions {
  machineId: string;
  filePath: string;
  /** Longest gap (ms) that is still caught up; 0 switches catch-up off. */
  maxAgeMs: number;
  log: BaselineLogger;
  now?: () => number;
  /** Rewrite the file at least this often even if nothing changed (keeps the "last seen" time fresh). */
  saveEveryMs?: number;
}

/**
 * Remembers the last counter values of one machine, in memory and on disk,
 * so that parts produced while the agent was not running (or could not reach
 * the PLC) can be booked afterwards. A source calls onFirstRead() for the
 * first reading after a start or after a lost connection, and onRead() for
 * every successful reading.
 */
export class CounterBaseline {
  private state: StoredCounters | null;
  private lastWriteMs = 0;
  private lastSaveWarnMs = 0;
  private readonly now: () => number;
  private readonly saveEveryMs: number;

  constructor(private readonly opts: CounterBaselineOptions) {
    this.state = loadCounters(opts.filePath);
    this.now = opts.now ?? Date.now;
    this.saveEveryMs = opts.saveEveryMs ?? 5000;
  }

  /** Returns how many parts to emit now for the gap since the last reading. */
  onFirstRead(good: number, scrap: number): CounterSnapshot {
    const nowMs = this.now();
    const plan = planCatchup(this.state, { good, scrap }, nowMs, this.opts.maxAgeMs);
    this.logPlan(plan);
    this.state = { good, scrap, seenAtMs: nowMs };
    this.persist(nowMs);
    return plan.emit;
  }

  onRead(good: number, scrap: number): void {
    const nowMs = this.now();
    const changed = !this.state || this.state.good !== good || this.state.scrap !== scrap;
    this.state = { good, scrap, seenAtMs: nowMs };
    if (changed || nowMs - this.lastWriteMs >= this.saveEveryMs) this.persist(nowMs);
  }

  private persist(nowMs: number): void {
    if (!this.state) return;
    try {
      saveCounters(this.opts.filePath, this.state);
      this.lastWriteMs = nowMs;
    } catch (err) {
      // Never let a full disk or a wrong path stop the counting itself.
      if (nowMs - this.lastSaveWarnMs >= 60000) {
        this.lastSaveWarnMs = nowMs;
        this.opts.log.warn({ err, machineId: this.opts.machineId, file: this.opts.filePath }, "could not save counter baseline");
      }
    }
  }

  private logPlan(plan: CatchupPlan): void {
    const ctx = { machineId: this.opts.machineId, ageSeconds: plan.ageMs === null ? null : Math.round(plan.ageMs / 1000) };
    switch (plan.note) {
      case "caught_up":
        this.opts.log.info({ ...ctx, ...plan.emit }, "catch-up: parts produced while not observed are booked now");
        break;
      case "too_old":
      case "too_large":
      case "disabled":
        this.opts.log.warn(
          { ...ctx, lostGood: plan.lost.good, lostScrap: plan.lost.scrap, reason: plan.note },
          "catch-up: parts produced while not observed were NOT booked",
        );
        break;
      case "counter_reset":
        this.opts.log.warn(ctx, "catch-up: a counter went backwards (PLC restart?); starting from the current values");
        break;
      case "first_start":
        this.opts.log.info(ctx, "catch-up: no earlier counter values known; starting from the current ones");
        break;
      case "no_gap":
        break;
    }
  }
}
