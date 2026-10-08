import { describe, expect, it } from "vitest";
import { assessEdgeOffline, describeSilence, offlineSecondsFromEnv } from "../edge-offline-health.js";

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const MIN = 60_000;
const beat = (name: string, minutesAgo: number) => ({ name, lastHeartbeatMs: NOW - minutesAgo * MIN, lastSeenMs: NOW - minutesAgo * MIN });
const stopped = (name: string, minutesAgo: number) => ({ name, lastHeartbeatMs: null, lastSeenMs: NOW - minutesAgo * MIN });

describe("assessEdgeOffline", () => {
  it("is healthy while every node reported within the limit", () => {
    expect(assessEdgeOffline([beat("a", 0.5), beat("b", 2)], NOW, 180)).toEqual({ healthy: true });
  });

  it("flags a node that is silent for more than the limit, with the duration", () => {
    const r = assessEdgeOffline([beat("node-gate-sim", 4)], NOW, 180);
    expect(r.healthy).toBe(false);
    if (!r.healthy) {
      expect(r.message).toContain("1 edge node has not reported for more than 3 min");
      expect(r.message).toContain("node-gate-sim (no heartbeat for 4 min)");
    }
  });

  it("the limit itself is not yet an alert, one millisecond more is", () => {
    expect(assessEdgeOffline([{ name: "a", lastHeartbeatMs: NOW - 180_000, lastSeenMs: NOW - 180_000 }], NOW, 180).healthy).toBe(true);
    expect(assessEdgeOffline([{ name: "a", lastHeartbeatMs: NOW - 180_001, lastSeenMs: NOW - 180_001 }], NOW, 180).healthy).toBe(false);
  });

  it("measures a cleanly stopped node (no heartbeat) from its last_seen_at", () => {
    const r = assessEdgeOffline([stopped("a", 12)], NOW, 180);
    expect(r.healthy).toBe(false);
    if (!r.healthy) expect(r.message).toContain("a (stopped 12 min ago)");
    expect(assessEdgeOffline([stopped("a", 1)], NOW, 180).healthy).toBe(true);
  });

  it("ignores a node that never reported", () => {
    expect(assessEdgeOffline([{ name: "new", lastHeartbeatMs: null, lastSeenMs: null }], NOW, 180)).toEqual({ healthy: true });
  });

  it("does not flag a heartbeat from the future (clock skew)", () => {
    expect(assessEdgeOffline([{ name: "a", lastHeartbeatMs: NOW + 5 * MIN, lastSeenMs: NOW + 5 * MIN }], NOW, 180).healthy).toBe(true);
  });

  it("lists the longest silent first, at most five, and counts the rest", () => {
    const rows = ["a", "b", "c", "d", "e", "f", "g"].map((n, i) => beat(n, 5 + i));
    const r = assessEdgeOffline(rows, NOW, 180);
    expect(r.healthy).toBe(false);
    if (!r.healthy) {
      expect(r.message).toContain("7 edge nodes have not reported");
      expect(r.message.indexOf("g (")).toBeLessThan(r.message.indexOf("c ("));
      expect(r.message).toContain("and 2 more");
      expect(r.message).not.toContain("a (no heartbeat");
    }
  });
});

describe("describeSilence", () => {
  it("uses minutes, hours and days", () => {
    expect(describeSilence(4 * MIN + 59_000)).toBe("4 min");
    expect(describeSilence(119 * MIN)).toBe("119 min");
    expect(describeSilence(5 * 3_600_000)).toBe("5 h");
    expect(describeSilence(50 * 3_600_000)).toBe("2 days");
  });
});

describe("offlineSecondsFromEnv", () => {
  it("defaults to 180 and accepts 120 to 86400 whole seconds only", () => {
    expect(offlineSecondsFromEnv({})).toBe(180);
    expect(offlineSecondsFromEnv({ EDGE_OFFLINE_ALERT_SECONDS: "300" })).toBe(300);
    expect(offlineSecondsFromEnv({ EDGE_OFFLINE_ALERT_SECONDS: "60" })).toBe(180);
    expect(offlineSecondsFromEnv({ EDGE_OFFLINE_ALERT_SECONDS: "1.5" })).toBe(180);
    expect(offlineSecondsFromEnv({ EDGE_OFFLINE_ALERT_SECONDS: "x" })).toBe(180);
    expect(offlineSecondsFromEnv({ EDGE_OFFLINE_ALERT_SECONDS: "100000" })).toBe(180);
  });
});
