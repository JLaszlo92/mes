/**
 * Offline start of the edge agent (chaos finding 21).
 *
 * If the claim fails because the backend cannot be reached, the agent starts its
 * channels from the cached configuration WITHOUT a lease and keeps trying to claim
 * in the background. Events are buffered on disk as always, so nothing is lost.
 */

/** The backend answered the claim with an HTTP error. */
export class ClaimHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ClaimHttpError";
  }
}

export const CLAIM_TIMEOUT_MS = 10_000;

/**
 *  - "unreachable": no answer (network, DNS, timeout) or the backend is down/overloaded (5xx, 408, 429)
 *                   -> an offline start from the cache is allowed
 *  - "rejected":    the backend answered and said no (invalid token, node removed, lease held by another
 *                   instance, ...) -> NO offline start: the server's decision must not be bypassed
 */
export function classifyClaimFailure(err: unknown): "unreachable" | "rejected" {
  if (err instanceof ClaimHttpError) {
    return err.status >= 500 || err.status === 408 || err.status === 429 ? "unreachable" : "rejected";
  }
  return "unreachable";
}

/** 5 s, 10 s, 20 s, 40 s, then every 60 s. */
export function nextBackoffMs(attempt: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempt), 60_000);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

/** True if two channel lists are equal (key order ignored, list order significant). */
export function sameChannels(a: unknown, b: unknown): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

/**
 * A lease held by a crashed instance of THIS node goes stale after 90 s, so a
 * rejection that persists for longer than that means another instance really owns
 * the node. 150 s = 90 s + margin.
 */
export const REJECTION_GRACE_MS = 150_000;

export interface BackgroundClaimDeps<T> {
  claim: () => Promise<T>;
  /** Called once with the successful claim. If it throws, the agent gives up. */
  onClaimed: (value: T) => Promise<void> | void;
  /** The server keeps rejecting the claim (or adopting it failed): the caller stops counting and exits. */
  onGiveUp: (reason: string) => void;
  onAttemptFailed?: (kind: "unreachable" | "rejected", err: unknown, nextInMs: number) => void;
  now?: () => number;
  rejectionGraceMs?: number;
}

export function startBackgroundClaim<T>(deps: BackgroundClaimDeps<T>): { stop: () => void } {
  const now = deps.now ?? (() => Date.now());
  const grace = deps.rejectionGraceMs ?? REJECTION_GRACE_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let firstRejectedAt: number | null = null;

  const schedule = (delayMs: number): void => {
    timer = setTimeout(() => void run(), delayMs);
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    let value: T;
    try {
      value = await deps.claim();
    } catch (err) {
      if (stopped) return;
      const kind = classifyClaimFailure(err);
      if (kind === "rejected") {
        firstRejectedAt ??= now();
        if (now() - firstRejectedAt >= grace) {
          deps.onGiveUp(`the backend keeps rejecting the claim: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      }
      attempt += 1;
      const nextIn = nextBackoffMs(attempt);
      deps.onAttemptFailed?.(kind, err, nextIn);
      schedule(nextIn);
      return;
    }
    if (stopped) return;
    try {
      await deps.onClaimed(value);
    } catch (err) {
      deps.onGiveUp(`adopting the claimed configuration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  schedule(nextBackoffMs(0));
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
