import { describe, expect, it } from "vitest";
import type { LicensePayload, LicenseStatus } from "../license.js";
import { licenseConfigFromEnv, licenseGuardDecision, licenseWarning, routeKind } from "../license-policy.js";

const payload: LicensePayload = {
  v: 1, licenseId: "lic-x", customer: "C", serial: 1,
  issuedAt: "2026-01-01T00:00:00.000Z", validFrom: "2026-01-01T00:00:00.000Z",
  validUntil: "2026-12-31T00:00:00.000Z", graceDays: 14, deviceCaSha256: "a".repeat(64),
  limits: { edgeNodes: 2, terminals: 5 },
};
const st = (state: LicenseStatus["state"], daysLeft: number | null = null, reason = "r"): LicenseStatus => ({
  state, reason, payload, daysLeft,
});

describe("routeKind", () => {
  it("never restricts reads, deletes or unlisted routes", () => {
    expect(routeKind("GET", "/api/edge-nodes")).toBe("free");
    expect(routeKind("DELETE", "/api/edge-nodes/:id")).toBe("free");
    expect(routeKind("POST", "/api/fault-reports")).toBe("free");
    expect(routeKind("POST", "/api/work-orders")).toBe("free");
  });
  it("never restricts the edge-node protocol or token rotation", () => {
    expect(routeKind("POST", "/api/edge-nodes/claim")).toBe("free");
    expect(routeKind("POST", "/api/edge-nodes/heartbeat")).toBe("free");
    expect(routeKind("POST", "/api/edge-nodes/:id/regenerate-token")).toBe("free");
  });
  it("classifies configuration and node creation", () => {
    expect(routeKind("POST", "/api/edge-nodes")).toBe("add-edge-node");
    expect(routeKind("POST", "/api/edge-nodes/:id/channels")).toBe("configuration");
    expect(routeKind("PATCH", "/api/machine-registry/:id")).toBe("configuration");
    expect(routeKind("PUT", "/api/alert-rules/:id")).toBe("configuration");
    expect(routeKind("post", "/api/machine-registry/bulk")).toBe("configuration");
    expect(routeKind("POST", "/api/sites")).toBe("configuration");
    expect(routeKind("PUT", "/api/areas/:id")).toBe("configuration");
    expect(routeKind("PATCH", "/api/lines/:id")).toBe("configuration");
    expect(routeKind("GET", "/api/plant-hierarchy")).toBe("free");
  });
  it("does not match a longer sibling prefix", () => {
    expect(routeKind("POST", "/api/edge-nodes-extra")).toBe("free");
  });
});

describe("licenseGuardDecision", () => {
  it("free routes are always allowed, even when expired", () => {
    expect(licenseGuardDecision("free", st("expired"), 99).allowed).toBe(true);
  });
  it("configuration follows the state", () => {
    expect(licenseGuardDecision("configuration", st("valid", 100), 0).allowed).toBe(true);
    expect(licenseGuardDecision("configuration", st("grace", 5), 0).allowed).toBe(true);
    expect(licenseGuardDecision("configuration", st("expired"), 0).allowed).toBe(false);
    expect(licenseGuardDecision("configuration", st("invalid"), 0).allowed).toBe(false);
  });
  it("node creation also checks the limit", () => {
    expect(licenseGuardDecision("add-edge-node", st("valid", 100), 1).allowed).toBe(true);
    const full = licenseGuardDecision("add-edge-node", st("valid", 100), 2);
    expect(full.allowed).toBe(false);
    expect(full.reason).toMatch(/2\/2/);
  });
});

describe("licenseWarning", () => {
  it("is silent for a healthy license", () => {
    expect(licenseWarning(st("valid", 200))).toBeNull();
  });
  it("warns when expiry is near, in grace, expired or invalid", () => {
    expect(licenseWarning(st("valid", 10))).toMatch(/expires in 10 day/);
    expect(licenseWarning(st("grace", 7))).toMatch(/grace period ends in 7/);
    expect(licenseWarning(st("expired"))).toMatch(/expired/);
    expect(licenseWarning({ state: "invalid", reason: "bad signature", payload: null, daysLeft: null })).toMatch(/bad signature/);
  });
});

describe("licenseConfigFromEnv", () => {
  it("defaults to audit mode", () => {
    const c = licenseConfigFromEnv({});
    expect(c.enforce).toBe(false);
    expect(c.file).toBe("/etc/mes/license.json");
  });
  it("accepts true/false and rejects typos instead of silently disabling", () => {
    expect(licenseConfigFromEnv({ LICENSE_ENFORCE: "TRUE" }).enforce).toBe(true);
    expect(() => licenseConfigFromEnv({ LICENSE_ENFORCE: "yes" })).toThrow(/LICENSE_ENFORCE/);
  });
});
