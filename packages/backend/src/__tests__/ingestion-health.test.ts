import { describe, expect, it } from "vitest";
import { DEFAULT_INGESTION_LIMITS, IngestionTracker, describeError, ingestionLimitsFromEnv } from "../ingestion-health.js";

function tracker(limits = DEFAULT_INGESTION_LIMITS) {
  let t = Date.UTC(2026, 9, 8, 15, 24, 0);
  return {
    tracker: new IngestionTracker(limits, () => t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}
const diskFull = Object.assign(new Error('could not extend file "base/16385/33557": No space left on device'), { code: "53100" });

describe("IngestionTracker", () => {
  it("is healthy without any event", () => {
    expect(tracker().tracker.status().failing).toBe(false);
  });

  it("does not alert before the minimum number of failures", () => {
    const { tracker: t, advance } = tracker();
    for (let i = 0; i < 4; i++) {
      t.recordFailure(diskFull);
      advance(20_000);
    }
    expect(t.status().failing).toBe(false);
    expect(t.status().failures).toBe(4);
  });

  it("does not alert before the streak has lasted long enough (a short hiccup)", () => {
    const { tracker: t, advance } = tracker();
    for (let i = 0; i < 10; i++) {
      t.recordFailure(diskFull);
      advance(1_000);
    }
    expect(t.status().failing).toBe(false);
  });

  it("alerts after 5 failures spread over 30 s, with the reason", () => {
    const { tracker: t, advance } = tracker();
    for (let i = 0; i < 5; i++) {
      t.recordFailure(diskFull);
      advance(8_000);
    }
    const s = t.status();
    expect(s.failing).toBe(true);
    expect(s.failures).toBe(5);
    expect(s.message).toContain("since 2026-10-08 15:24 UTC");
    expect(s.message).toContain("53100: could not extend file");
    expect(s.message).toContain("edge devices keep buffering");
  });

  it("one stored event ends the streak", () => {
    const { tracker: t, advance } = tracker();
    for (let i = 0; i < 6; i++) {
      t.recordFailure(diskFull);
      advance(8_000);
    }
    expect(t.status().failing).toBe(true);
    t.recordSuccess();
    expect(t.status()).toMatchObject({ failing: false, failures: 0 });
  });

  it("a success in the middle restarts the count", () => {
    const { tracker: t, advance } = tracker();
    for (let i = 0; i < 4; i++) {
      t.recordFailure(diskFull);
      advance(10_000);
    }
    t.recordSuccess();
    t.recordFailure(diskFull);
    advance(10_000);
    expect(t.status().failing).toBe(false);
  });

  it("is unknown (not failing) when no failure came for the stale time, e.g. the edge nodes stopped sending", () => {
    const { tracker: t, advance } = tracker();
    for (let i = 0; i < 6; i++) {
      t.recordFailure(diskFull);
      advance(8_000);
    }
    expect(t.status().failing).toBe(true);
    advance(DEFAULT_INGESTION_LIMITS.staleMs + 1);
    expect(t.status().failing).toBe(false);
  });

  it("a failure after a long pause starts a new streak", () => {
    const { tracker: t, advance } = tracker();
    for (let i = 0; i < 6; i++) {
      t.recordFailure(diskFull);
      advance(8_000);
    }
    advance(DEFAULT_INGESTION_LIMITS.staleMs + 1);
    t.recordFailure(diskFull);
    expect(t.status()).toMatchObject({ failing: false, failures: 1 });
  });

  it("the message is stable while the streak goes on (the alert is not rewritten for every failure)", () => {
    const { tracker: t, advance } = tracker();
    for (let i = 0; i < 6; i++) {
      t.recordFailure(diskFull);
      advance(8_000);
    }
    const first = t.status().message;
    t.recordFailure(diskFull);
    expect(t.status().message).toBe(first);
  });

  it("honours custom limits", () => {
    const { tracker: t } = tracker({ minFailures: 2, minDurationMs: 0, staleMs: 60_000 });
    t.recordFailure(diskFull);
    t.recordFailure(diskFull);
    expect(t.status().failing).toBe(true);
  });
});

describe("describeError", () => {
  it("joins the code and the message", () => {
    expect(describeError(diskFull)).toBe('53100: could not extend file "base/16385/33557": No space left on device');
  });
  it("uses the code alone when the message is empty (a refused connection)", () => {
    expect(describeError(Object.assign(new Error(""), { code: "ECONNREFUSED" }))).toBe("ECONNREFUSED");
  });
  it("shortens a long message and removes line breaks", () => {
    const out = describeError(new Error("a\n".repeat(300)));
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).not.toContain("\n");
  });
  it("handles a non-error value", () => {
    expect(describeError("boom")).toBe("boom");
    expect(describeError(undefined)).toBe("undefined");
  });
});

describe("ingestionLimitsFromEnv", () => {
  it("has the defaults", () => {
    expect(ingestionLimitsFromEnv({})).toEqual(DEFAULT_INGESTION_LIMITS);
  });
  it("reads the count and the seconds", () => {
    expect(ingestionLimitsFromEnv({ INGESTION_FAIL_COUNT: "3", INGESTION_FAIL_SECONDS: "10" })).toMatchObject({ minFailures: 3, minDurationMs: 10_000 });
  });
  it("ignores nonsense", () => {
    expect(ingestionLimitsFromEnv({ INGESTION_FAIL_COUNT: "abc", INGESTION_FAIL_SECONDS: "-5" })).toEqual(DEFAULT_INGESTION_LIMITS);
  });
});
