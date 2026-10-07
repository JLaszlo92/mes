/**
 * Collects acknowledged event ids and hands them over together after a short delay.
 * The buffer file is rewritten on every removal; with one rewrite per ack a backlog
 * of a few hundred events (plus the duplicate acks the backend sends) kept the edge
 * agent busy for tens of seconds. A failing flush is reported, never thrown: the
 * events then simply stay in the buffer and are sent (and de-duplicated) again.
 */
export class AckBatcher {
  private ids = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly flush: (ids: ReadonlySet<string>) => void,
    private readonly onError: (err: unknown) => void = () => {},
    private readonly delayMs: number = 250,
  ) {}

  add(sourceEventId: string): void {
    this.ids.add(sourceEventId);
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flushNow(), this.delayMs);
      this.timer.unref?.();
    }
  }

  flushNow(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.ids.size === 0) return;
    const ids = this.ids;
    this.ids = new Set();
    try {
      this.flush(ids);
    } catch (err) {
      this.onError(err);
    }
  }
}
