/**
 * "Can the backend store the events it receives?" (chaos slice 23, finding 39).
 *
 * With a full disk the database still answers SELECTs, so /health?db=1 and the connection-failure banner see nothing, while
 * every event insert fails: the edge nodes buffer silently. The MQTT subscriber reports each stored event and each failed
 * store here; a streak of failures without a single success is "ingestion failing".
 *
 * The state lives in memory on purpose: the alert is written to the same database that may not be able to write, so the
 * state must also be readable without it (GET /health?db=1).
 */
export const INGESTION_ALERT_TYPE = "ingestion_failing";

/** Body of GET /health?db=1 while events cannot be stored. /health is public, so no internals (the reason is in the alert). */
export const INGESTION_FAILING_BODY = { statusCode: 503, error: "Service Unavailable", code: "ingestion_failing", message: "Events cannot be stored" } as const;

export interface IngestionLimits {
  /** A streak needs at least this many failures in a row ... */
  minFailures: number;
  /** ... and at least this long between its first and its last failure, so a short hiccup does not alert. */
  minDurationMs: number;
  /** No failure for this long (e.g. the edge nodes stopped sending): the state is unknown, not failing. */
  staleMs: number;
}

export const DEFAULT_INGESTION_LIMITS: IngestionLimits = { minFailures: 5, minDurationMs: 30_000, staleMs: 120_000 };

function numberFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** INGESTION_FAIL_COUNT (default 5) and INGESTION_FAIL_SECONDS (default 30). */
export function ingestionLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): IngestionLimits {
  return {
    minFailures: numberFromEnv(env, "INGESTION_FAIL_COUNT", DEFAULT_INGESTION_LIMITS.minFailures),
    minDurationMs: numberFromEnv(env, "INGESTION_FAIL_SECONDS", DEFAULT_INGESTION_LIMITS.minDurationMs / 1000) * 1000,
    staleMs: DEFAULT_INGESTION_LIMITS.staleMs,
  };
}

/** "53100: could not extend file ... No space left on device" - the SQLSTATE / system code plus a short message. */
export function describeError(err: unknown): string {
  const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim().slice(0, 200);
  if (code && message) return `${code}: ${message}`;
  return code || message || "unknown error";
}

export interface IngestionStatus {
  failing: boolean;
  failures: number;
  /** Start of the streak (epoch ms), null while healthy. */
  sinceMs: number | null;
  lastError: string | null;
  /** Stable text for the alert (it changes only with the last error, not with every failure). */
  message: string;
}

export class IngestionTracker {
  private failures = 0;
  private firstFailureAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly limits: IngestionLimits = DEFAULT_INGESTION_LIMITS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** An event was stored (inserted or recognised as a duplicate): the streak is over. */
  recordSuccess(): void {
    this.failures = 0;
    this.firstFailureAt = null;
    this.lastFailureAt = null;
    this.lastError = null;
  }

  /** The database refused or could not store an event (or the machine lookup failed). */
  recordFailure(err: unknown): void {
    const t = this.now();
    if (this.lastFailureAt !== null && t - this.lastFailureAt > this.limits.staleMs) {
      this.failures = 0;
      this.firstFailureAt = null;
    }
    this.firstFailureAt ??= t;
    this.lastFailureAt = t;
    this.failures += 1;
    this.lastError = describeError(err);
  }

  status(): IngestionStatus {
    const healthy = { failing: false, failures: 0, sinceMs: null, lastError: null, message: "" };
    if (this.failures === 0 || this.firstFailureAt === null || this.lastFailureAt === null) return healthy;
    if (this.now() - this.lastFailureAt > this.limits.staleMs) return healthy;
    const failing = this.failures >= this.limits.minFailures && this.lastFailureAt - this.firstFailureAt >= this.limits.minDurationMs;
    if (!failing) return { ...healthy, failures: this.failures, sinceMs: this.firstFailureAt, lastError: this.lastError };
    const since = new Date(this.firstFailureAt).toISOString().slice(0, 16).replace("T", " ");
    return {
      failing: true,
      failures: this.failures,
      sinceMs: this.firstFailureAt,
      lastError: this.lastError,
      message:
        `Events cannot be stored since ${since} UTC (last error: ${this.lastError}). The edge devices keep buffering their events, ` +
        `so nothing is lost while their disks last - check the database and its disk space.`,
    };
  }
}

/** The one tracker of this backend process (mqtt-subscriber writes to it, the evaluator and /health read it). */
export const ingestionHealth = new IngestionTracker(ingestionLimitsFromEnv());
