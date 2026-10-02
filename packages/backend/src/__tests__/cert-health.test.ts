import { describe, expect, it } from "vitest";
import { assessCertHealth, type CertStatusRow } from "../cert-health.js";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const H = 3_600_000;
const row = (over: Partial<CertStatusRow> = {}): CertStatusRow => ({
  last_run_at: new Date(NOW.getTime() - 2 * H),
  last_status: "success",
  last_error: null,
  ...over,
});

describe("assessCertHealth", () => {
  it("is healthy after a recent clean check", () => {
    expect(assessCertHealth(row(), NOW)).toEqual({ healthy: true });
  });

  it("stays healthy up to three days after the last clean check", () => {
    expect(assessCertHealth(row({ last_run_at: new Date(NOW.getTime() - 71 * H) }), NOW).healthy).toBe(true);
  });

  it("alerts when no check ever ran", () => {
    const h = assessCertHealth(undefined, NOW);
    expect(h.healthy).toBe(false);
    expect(h).toMatchObject({ message: expect.stringMatching(/install mes-cert-check\.timer/) });
  });

  it("alerts with the reason when the last check failed", () => {
    const h = assessCertHealth(row({ last_status: "failure", last_error: "nginx-proxy: expires in 12 day(s)" }), NOW);
    expect(h).toMatchObject({ healthy: false, message: expect.stringContaining("nginx-proxy: expires in 12 day(s)") });
  });

  it("copes with a failure that has no message", () => {
    const h = assessCertHealth(row({ last_status: "failure" }), NOW);
    expect(h).toMatchObject({ healthy: false, message: expect.stringContaining("the check failed") });
  });

  it("alerts when the monitor itself went silent (dead man's switch)", () => {
    const h = assessCertHealth(row({ last_run_at: new Date(NOW.getTime() - 73 * H) }), NOW);
    expect(h).toMatchObject({ healthy: false, message: expect.stringMatching(/No certificate expiry check since/) });
  });
});
