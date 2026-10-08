/**
 * The first claim of a starting agent (chaos finding 34).
 *
 * "unreachable" is handled by the caller (offline start from the cache), so it is thrown straight away.
 * "rejected" (invalid token, lease held by someone else, ...) used to end the process at once; systemd
 * restarted it after 2 s and the loop repeated every ~4.5 s (13 claims a minute) for as long as the
 * condition lasted. A lease of a crashed instance of THIS node expires after 90 s, so waiting is the
 * right answer: ask again with the same backoff as the background claim (5, 10, 20, 40, then 60 s)
 * until the rejection has lasted REJECTION_GRACE_MS, then give up with the last error. No channel is
 * started in the meantime, so nothing is published without a lease.
 */
import { classifyClaimFailure, nextBackoffMs, REJECTION_GRACE_MS } from "./offline-claim.js";

export interface InitialClaimDeps<T> {
  claim: () => Promise<T>;
  /** Called after every rejected attempt that will be retried. */
  onRejected?: (err: unknown, nextInMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  rejectionGraceMs?: number;
}

export async function claimWaitingOutRejection<T>(deps: InitialClaimDeps<T>): Promise<T> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const grace = deps.rejectionGraceMs ?? REJECTION_GRACE_MS;
  let attempt = 0;
  let firstRejectedAt: number | null = null;
  for (;;) {
    try {
      return await deps.claim();
    } catch (err) {
      if (classifyClaimFailure(err) !== "rejected") throw err;
      firstRejectedAt ??= now();
      if (now() - firstRejectedAt >= grace) throw err;
      const waitMs = nextBackoffMs(attempt);
      attempt += 1;
      deps.onRejected?.(err, waitMs);
      await sleep(waitMs);
    }
  }
}
