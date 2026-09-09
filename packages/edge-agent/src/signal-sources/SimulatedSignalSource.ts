import type { SignalReading, SignalSource } from "./SignalSource.js";

const SCRAP_REASON_CODES = ["misalign", "dimension_oor", "surface_defect"];

interface SimulatedSignalSourceOptions {
  /** Average milliseconds between good/scrap part pulses. */
  avgCycleMs?: number;
  /** Probability (0-1) that a given part is scrap rather than good. */
  scrapRate?: number;
  /** Average milliseconds the machine stays "running" before a downtime event. */
  avgUptimeMs?: number;
  /** How long a simulated downtime lasts, in milliseconds. */
  downtimeDurationMs?: number;
}

/**
 * Stands in for a real machine connection so M0 (the walking skeleton) can
 * be built, run, and demoed end-to-end without shop-floor access or I/O
 * hardware. It emits the same two event kinds a real discrete-I/O or
 * protocol-based connection would (PRD Section 5.5): a good/scrap pulse per
 * part, and machine-status transitions (here: running <-> down; idle and
 * changeover arrive with real job-tracking in M2).
 *
 * Jitter is deliberate, not decorative — a fixed interval would let bugs in
 * the buffering/ordering logic hide behind suspiciously regular timing.
 */
export class SimulatedSignalSource implements SignalSource {
  readonly name = "simulated";

  private readonly avgCycleMs: number;
  private readonly scrapRate: number;
  private readonly avgUptimeMs: number;
  private readonly downtimeDurationMs: number;

  private cycleTimer: NodeJS.Timeout | null = null;
  private downtimeTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: SimulatedSignalSourceOptions = {}) {
    this.avgCycleMs = options.avgCycleMs ?? 3000;
    this.scrapRate = options.scrapRate ?? 0.08;
    this.avgUptimeMs = options.avgUptimeMs ?? 60_000;
    this.downtimeDurationMs = options.downtimeDurationMs ?? 10_000;
  }

  start(onReading: (reading: SignalReading) => void): void {
    this.running = true;
    onReading({ kind: "machine_status", status: "running" });
    this.scheduleNextPart(onReading);
    this.scheduleNextDowntime(onReading);
  }

  stop(): void {
    this.running = false;
    if (this.cycleTimer) clearTimeout(this.cycleTimer);
    if (this.downtimeTimer) clearTimeout(this.downtimeTimer);
  }

  private scheduleNextPart(onReading: (reading: SignalReading) => void): void {
    const jitter = 0.5 + Math.random(); // 0.5x-1.5x average
    this.cycleTimer = setTimeout(() => {
      if (!this.running) return;
      const isScrap = Math.random() < this.scrapRate;
      onReading(
        isScrap
          ? {
              kind: "production_count",
              result: "scrap",
              scrapReasonCode:
                SCRAP_REASON_CODES[Math.floor(Math.random() * SCRAP_REASON_CODES.length)],
            }
          : { kind: "production_count", result: "good" },
      );
      this.scheduleNextPart(onReading);
    }, this.avgCycleMs * jitter);
  }

  private scheduleNextDowntime(onReading: (reading: SignalReading) => void): void {
    const jitter = 0.6 + Math.random() * 0.8;
    this.downtimeTimer = setTimeout(() => {
      if (!this.running) return;
      onReading({ kind: "machine_status", status: "down" });
      setTimeout(() => {
        if (!this.running) return;
        onReading({ kind: "machine_status", status: "running" });
        this.scheduleNextDowntime(onReading);
      }, this.downtimeDurationMs);
    }, this.avgUptimeMs * jitter);
  }
}
