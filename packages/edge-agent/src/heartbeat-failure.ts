/**
 * What a failed heartbeat means (chaos finding 33).
 *
 * Until v14 every non-2xx answer was turned into "no measurement" and nothing was logged, so an agent
 * whose lease had been taken (HTTP 409: another instance claimed the node, or the backend forgot the
 * session) kept running without a lease, silently, while the node showed as offline.
 */

/** The backend answered a heartbeat with an HTTP error. */
export class HeartbeatHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HeartbeatHttpError";
  }
}

/**
 *  - "lease_lost": the backend answered and said no (409 session is not the current one, 401 invalid token,
 *                  404, 400, ...) -> claim again; if it stays refused the agent stops (v12 rules)
 *  - "transient":  no answer (network, timeout), 5xx, 408, 429 or anything else -> try again at the next tick
 */
export function classifyHeartbeatFailure(err: unknown): "lease_lost" | "transient" {
  if (err instanceof HeartbeatHttpError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
    return "lease_lost";
  }
  return "transient";
}
