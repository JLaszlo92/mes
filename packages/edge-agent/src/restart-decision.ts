/**
 * When an edge agent restarts itself (exit code 75, the unit's Restart=on-failure brings it back after 2 s, the lease is
 * handed back first). Pure, so it is unit-tested. The heartbeat answer carries two things:
 *  - restartRequested: "Restart agent" in the dashboard. Acted on at once (but not in the first seconds of a start).
 *  - configRevision: a different revision than the claim's means the channels or settings were changed. Acted on only
 *    when the same new revision is seen twice in a row (about 30 s of stability, so several edits in a row restart the
 *    agent once) and the process has run for a minute (no restart loop whatever the backend answers).
 */
export const RESTART_EXIT_CODE = 75;
export const MIN_UPTIME_FOR_REQUEST_MS = 20_000;
export const MIN_UPTIME_FOR_REVISION_MS = 60_000;

export interface HeartbeatInfo {
  configRevision: string | null;
  restartRequested: boolean;
}

export class RestartDecider {
  private pendingRevision: string | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly startedAtMs: number = now(),
  ) {}

  /** The reason to restart now, or null. */
  decide(claimedRevision: string | null, hb: HeartbeatInfo): string | null {
    const uptime = this.now() - this.startedAtMs;
    if (hb.restartRequested && uptime >= MIN_UPTIME_FOR_REQUEST_MS) return "a restart was requested from the dashboard";

    if (claimedRevision === null || hb.configRevision === null || hb.configRevision === claimedRevision) {
      this.pendingRevision = null;
      return null;
    }
    if (this.pendingRevision === hb.configRevision && uptime >= MIN_UPTIME_FOR_REVISION_MS) {
      return "the channel or node configuration was changed in the dashboard";
    }
    this.pendingRevision = hb.configRevision;
    return null;
  }
}
