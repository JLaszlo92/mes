import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, AUTHENTICATED, effectivePermissions, isPermission, requirementFor, requiresMfa, ROUTE_PERMISSIONS } from "../permissions.js";
import { isPublicRoute } from "../auth-guard.js";

const SRC = path.join(__dirname, "..");

describe("requirementFor", () => {
  it("uses the map, HEAD as GET", () => {
    expect(requirementFor("POST", "/api/work-orders")).toBe("work_orders.manage");
    expect(requirementFor("GET", "/api/audit-log")).toBe("admin.audit");
    expect(requirementFor("HEAD", "/api/audit-log")).toBe("admin.audit");
  });
  it("lets any signed-in user read what is not listed, and denies unlisted writes", () => {
    expect(requirementFor("GET", "/api/work-orders")).toBe(AUTHENTICATED);
    expect(requirementFor("POST", "/api/something-new")).toBe("deny");
    expect(requirementFor("DELETE", undefined)).toBe("deny");
  });
});

describe("effectivePermissions", () => {
  it("gives admin everything and others only known grants", () => {
    expect(effectivePermissions("admin", [])).toEqual([...ALL_PERMISSIONS]);
    expect(effectivePermissions("operator", ["terminal.report_fault", "bogus"])).toEqual(["terminal.report_fault"]);
  });
  it("asks MFA for administration permissions only", () => {
    expect(requiresMfa(["admin.users"])).toBe(true);
    expect(requiresMfa(["work_orders.manage", "terminal.report_fault"])).toBe(false);
  });
});

describe("the route map", () => {
  it("names only known permissions", () => {
    for (const [route, p] of Object.entries(ROUTE_PERMISSIONS)) {
      if (p !== AUTHENTICATED) expect(isPermission(p), route).toBe(true);
    }
  });

  // Every write route in the source must be either in the map or public: an
  // unlisted one answers 403 to everyone, which is safe but a bug.
  it("covers every write route in the source", () => {
    const routes: string[] = [];
    for (const file of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(path.join(SRC, file), "utf8");
      for (const m of text.matchAll(/app\.(post|put|patch|delete)(?:<[^(]*?>)?\(\s*["`]([^"`]+)["`]/g)) {
        routes.push(`${m[1]!.toUpperCase()} ${m[2]}`);
      }
    }
    // plant-hierarchy-routes builds its paths from a list
    for (const p of ["/api/sites", "/api/areas", "/api/lines"]) routes.push(`POST ${p}`, `PATCH ${p}/:id`, `DELETE ${p}/:id`);
    const missing = routes
      .filter((r) => !r.includes("${"))
      .filter((r) => {
        const [method, pattern] = r.split(" ") as [string, string];
        return !ROUTE_PERMISSIONS[r] && !isPublicRoute(method, pattern) && pattern !== "/api/auth/logout";
      });
    expect(missing).toEqual([]);
    expect(routes.length).toBeGreaterThan(60);
  });

  it("the default grants in migration 048 name only known permissions", () => {
    const sql = readFileSync(path.join(SRC, "..", "sql", "048_roles_permissions_workers.sql"), "utf8");
    const granted = [...sql.matchAll(/\('[a-z_]+', '([a-z_.]+)'\)/g)].map((m) => m[1]!);
    const later = readFileSync(path.join(SRC, "..", "sql", "049_manual_machine_status.sql"), "utf8");
    granted.push(...[...later.matchAll(/SELECT r\.id, '([a-z_.]+)'/g)].map((m) => m[1]!));
    expect(granted.length).toBeGreaterThan(30);
    expect(granted.filter((p) => !isPermission(p))).toEqual([]);
  });
});
