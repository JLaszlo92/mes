import { describe, expect, it } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { createIngestionCheck } from "../ingestion-health-evaluator.js";
import { INGESTION_ALERT_TYPE, IngestionTracker } from "../ingestion-health.js";

function setup() {
  let t = Date.UTC(2026, 9, 8, 15, 24, 0);
  const tracker = new IngestionTracker({ minFailures: 2, minDurationMs: 0, staleMs: 120_000 }, () => t);
  const calls: string[] = [];
  const logs: string[] = [];
  let raiseResult: boolean | Error = true;
  let resolveResult = true;
  const log = {
    info: (_o: unknown, m?: string) => logs.push(`info ${m ?? _o}`),
    warn: (_o: unknown, m?: string) => logs.push(`warn ${m ?? _o}`),
  } as unknown as FastifyBaseLogger;
  const check = createIngestionCheck(log, tracker, {
    raise: async (type, message) => {
      calls.push(`raise ${type} ${message.slice(0, 20)}`);
      if (raiseResult instanceof Error) throw raiseResult;
      return raiseResult;
    },
    resolve: async (type) => {
      calls.push(`resolve ${type}`);
      return resolveResult;
    },
  });
  return {
    tracker,
    check,
    calls,
    logs,
    setRaise: (r: boolean | Error) => (raiseResult = r),
    setResolve: (r: boolean) => (resolveResult = r),
    advance: (ms: number) => (t += ms),
  };
}
const err = new Error("No space left on device");

describe("createIngestionCheck", () => {
  it("resolves a stale alert of a previous run once, at the first healthy check, and then stays quiet", async () => {
    const s = setup();
    await s.check();
    await s.check();
    await s.check();
    expect(s.calls).toEqual([`resolve ${INGESTION_ALERT_TYPE}`]);
  });

  it("raises while ingestion fails and logs it once", async () => {
    const s = setup();
    s.tracker.recordFailure(err);
    s.tracker.recordFailure(err);
    await s.check();
    expect(s.calls).toEqual([`raise ${INGESTION_ALERT_TYPE} Events cannot be sto`]);
    expect(s.logs.filter((l) => l.includes("ingestion alert raised"))).toHaveLength(1);
    s.setRaise(false); // already open: update only
    await s.check();
    expect(s.logs.filter((l) => l.includes("ingestion alert raised"))).toHaveLength(1);
  });

  it("resolves after the first stored event", async () => {
    const s = setup();
    s.tracker.recordFailure(err);
    s.tracker.recordFailure(err);
    await s.check();
    s.tracker.recordSuccess();
    await s.check();
    expect(s.calls.at(-1)).toBe(`resolve ${INGESTION_ALERT_TYPE}`);
    expect(s.logs.some((l) => l.includes("can be stored again"))).toBe(true);
  });

  it("keeps trying when the alert cannot be written (full disk) and does not throw", async () => {
    const s = setup();
    s.setRaise(new Error("No space left on device"));
    s.tracker.recordFailure(err);
    s.tracker.recordFailure(err);
    await s.check();
    await s.check();
    expect(s.calls.filter((c) => c.startsWith("raise"))).toHaveLength(2);
    expect(s.logs.some((l) => l.includes("could not record the ingestion alert"))).toBe(true);
    s.setRaise(true);
    await s.check();
    expect(s.logs.some((l) => l.includes("ingestion alert raised"))).toBe(true);
  });

  it("after the failure goes stale (the edge nodes stopped) the alert is resolved", async () => {
    const s = setup();
    s.tracker.recordFailure(err);
    s.tracker.recordFailure(err);
    await s.check();
    s.advance(121_000);
    await s.check();
    expect(s.calls.at(-1)).toBe(`resolve ${INGESTION_ALERT_TYPE}`);
  });
});
