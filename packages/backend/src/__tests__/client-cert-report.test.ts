import { describe, expect, it } from "vitest";
import { clientCertView, parseClientCertReport, storedExpiryMs } from "../client-cert-report.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

describe("parseClientCertReport", () => {
  it("accepts an expiry in milliseconds and returns a Date", () => {
    expect(parseClientCertReport({ expiresAtMs: NOW + 365 * DAY })?.getTime()).toBe(NOW + 365 * DAY);
    expect(parseClientCertReport({ expiresAtMs: NOW + 0.4 })?.getTime()).toBe(NOW);
  });

  it("rejects anything else (older agents and devices without a certificate send nothing)", () => {
    for (const bad of [undefined, null, 5, "x", {}, { expiresAtMs: "1" }, { expiresAtMs: NaN }, { expiresAtMs: 0 }, { expiresAtMs: 1e18 }, { expiresAtMs: Date.UTC(1999, 0, 1) }]) {
      expect(parseClientCertReport(bad)).toBeNull();
    }
  });
});

describe("storedExpiryMs", () => {
  it("reads a Date or an ISO string and nothing else", () => {
    expect(storedExpiryMs(new Date(NOW))).toBe(NOW);
    expect(storedExpiryMs(new Date(NOW).toISOString())).toBe(NOW);
    expect(storedExpiryMs(null)).toBeNull();
    expect(storedExpiryMs(undefined)).toBeNull();
    expect(storedExpiryMs("garbage")).toBeNull();
    expect(storedExpiryMs(new Date("garbage"))).toBeNull();
  });
});

describe("clientCertView", () => {
  it("is empty when nothing is stored", () => {
    expect(clientCertView(null, NOW)).toEqual({ clientCertExpiresAt: null, clientCertDaysLeft: null, clientCertExpiring: false });
  });

  it("counts whole days and flags the warning period", () => {
    expect(clientCertView(new Date(NOW + 364.5 * DAY), NOW, 30)).toEqual({
      clientCertExpiresAt: new Date(NOW + 364.5 * DAY).toISOString(),
      clientCertDaysLeft: 364,
      clientCertExpiring: false,
    });
    expect(clientCertView(new Date(NOW + 30 * DAY), NOW, 30)).toMatchObject({ clientCertDaysLeft: 30, clientCertExpiring: true });
    expect(clientCertView(new Date(NOW + 31 * DAY), NOW, 30)).toMatchObject({ clientCertExpiring: false });
  });

  it("shows an expired certificate with negative days", () => {
    expect(clientCertView(new Date(NOW - 3 * DAY), NOW, 30)).toMatchObject({ clientCertDaysLeft: -3, clientCertExpiring: true });
    expect(clientCertView(new Date(NOW - 1000), NOW, 30)).toMatchObject({ clientCertDaysLeft: -1, clientCertExpiring: true });
  });
});
