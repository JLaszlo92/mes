import { describe, expect, it } from "vitest";
import { assessEdgeCerts, describeCertLeft, isCertExpiring, warnDaysFromEnv } from "../edge-cert-health.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

describe("warnDaysFromEnv", () => {
  it("defaults to 30 and accepts a whole number of days from 1 to 3650", () => {
    expect(warnDaysFromEnv({})).toBe(30);
    expect(warnDaysFromEnv({ EDGE_CERT_WARN_DAYS: "" })).toBe(30);
    expect(warnDaysFromEnv({ EDGE_CERT_WARN_DAYS: "400" })).toBe(400);
    for (const bad of ["0", "-5", "3651", "abc", "1.5"]) expect(warnDaysFromEnv({ EDGE_CERT_WARN_DAYS: bad })).toBe(30);
  });
});

describe("isCertExpiring", () => {
  it("is true at the limit and for anything already expired", () => {
    expect(isCertExpiring(NOW + 30 * DAY, NOW)).toBe(true);
    expect(isCertExpiring(NOW + 30 * DAY + 1, NOW)).toBe(false);
    expect(isCertExpiring(NOW - 5 * DAY, NOW)).toBe(true);
  });
});

describe("describeCertLeft", () => {
  it("describes both sides of the expiry", () => {
    expect(describeCertLeft(12 * DAY)).toBe("expires in 12 days");
    expect(describeCertLeft(5 * HOUR)).toBe("expires in 5 h");
    expect(describeCertLeft(10 * 60_000)).toBe("expires within the hour");
    expect(describeCertLeft(-10 * 60_000)).toBe("expired less than an hour ago");
    expect(describeCertLeft(-5 * HOUR)).toBe("expired 5 h ago");
    expect(describeCertLeft(-3 * DAY)).toBe("expired 3 days ago");
  });
});

describe("assessEdgeCerts", () => {
  it("is healthy when every reported certificate is further away than the limit, or nothing is reported", () => {
    expect(assessEdgeCerts([], NOW)).toEqual({ healthy: true });
    expect(assessEdgeCerts([{ name: "a", expiresAtMs: NOW + 360 * DAY }, { name: "b", expiresAtMs: null }], NOW)).toEqual({ healthy: true });
  });

  it("names a node whose certificate expires soon", () => {
    const health = assessEdgeCerts([{ name: "node-gate-sim", expiresAtMs: NOW + 12 * DAY }], NOW);
    expect(health.healthy).toBe(false);
    if (health.healthy) return;
    expect(health.message).toContain("1 edge node expires within 30 days or has expired: node-gate-sim (expires in 12 days)");
    expect(health.message).toContain("mes-ca.sh issue-device");
  });

  it("lists the soonest first, at most five, and counts the rest", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ name: `n${i}`, expiresAtMs: NOW + (i + 3) * DAY }));
    rows.push({ name: "fine", expiresAtMs: NOW + 200 * DAY });
    const health = assessEdgeCerts(rows.reverse(), NOW);
    expect(health.healthy).toBe(false);
    if (health.healthy) return;
    expect(health.message).toContain("7 edge nodes");
    expect(health.message).toContain("n0 (expires in 3 days), n1 (expires in 4 days), n2 (expires in 5 days), n3 (expires in 6 days), n4 (expires in 7 days) and 2 more");
    expect(health.message).not.toContain("fine");
  });

  it("reports an expired certificate of an offline node too, and honours a longer warning period", () => {
    const expired = assessEdgeCerts([{ name: "dead", expiresAtMs: NOW - 2 * DAY }], NOW);
    expect(expired.healthy).toBe(false);
    if (!expired.healthy) expect(expired.message).toContain("dead (expired 2 days ago)");
    expect(assessEdgeCerts([{ name: "a", expiresAtMs: NOW + 360 * DAY }], NOW, 400).healthy).toBe(false);
  });
});
