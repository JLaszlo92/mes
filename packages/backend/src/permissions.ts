/**
 * Jogosultságok — az EGYETLEN lista. A szerepekhez rendelésük adat
 * (role_permissions, Admin → Roles); az admin szerep mindig mindet megkapja.
 *
 * Az ellenőrzés központi: ROUTE_PERMISSIONS mondja meg, melyik route-hoz
 * milyen jog kell (auth-guard.ts érvényesíti). Egy írási route (POST/PUT/
 * PATCH/DELETE), amely nincs a listán, 403-at ad — elfelejtett route így nem
 * lehet nyitva. GET route-ot bármely bejelentkezett felhasználó olvashat,
 * hacsak a lista mást nem mond.
 */

export const PERMISSIONS = [
  { key: "work_orders.manage", group: "Production", label: "Create, edit, release and cancel work orders" },
  { key: "schedule.manage", group: "Production", label: "Schedule work orders on machines (Gantt)" },
  { key: "materials.receive", group: "Production", label: "Register material lots (goods receipt)" },
  { key: "materials.manage", group: "Production", label: "Edit and delete material lots" },
  { key: "materials.assign", group: "Production", label: "Record material lots on work orders" },

  { key: "faults.report", group: "Quality", label: "Report faults in the dashboard" },
  { key: "faults.review", group: "Quality", label: "Review fault reports" },
  { key: "downtime.explain", group: "Quality", label: "Give the reason for downtime" },
  { key: "corrective.log", group: "Quality", label: "Log corrective actions" },
  { key: "corrective.sign_off", group: "Quality", label: "Sign off corrective actions" },
  { key: "instructions.manage", group: "Quality", label: "Create and edit work instructions" },
  { key: "instructions.view_log", group: "Quality", label: "See who opened work instructions" },

  { key: "maintenance.manage", group: "Maintenance", label: "Create and update maintenance work orders, log parts and hours" },
  { key: "maintenance.plan", group: "Maintenance", label: "Preventive maintenance schedules" },

  { key: "alerts.acknowledge", group: "Alerts", label: "Acknowledge alerts" },
  { key: "alerts.rules", group: "Alerts", label: "Configure alert rules" },

  { key: "terminal.start_work_order", group: "Terminal", label: "Start a work order at the terminal" },
  { key: "terminal.complete_work_order", group: "Terminal", label: "Complete a work order at the terminal" },
  { key: "terminal.report_fault", group: "Terminal", label: "Report a fault at the terminal" },
  { key: "terminal.open_instructions", group: "Terminal", label: "Open work instructions at the terminal" },
  { key: "terminal.set_status", group: "Terminal", label: "Set the machine status at the terminal" },

  { key: "admin.machines", group: "Administration", label: "Machines, sites and lines, shifts, statuses, fault codes" },
  { key: "admin.edge_nodes", group: "Administration", label: "Edge nodes and data sources" },
  { key: "admin.terminals", group: "Administration", label: "Terminals and their pairing" },
  { key: "admin.users", group: "Administration", label: "Users, roles and permissions" },
  { key: "admin.audit", group: "Administration", label: "Audit log" },
  { key: "admin.license", group: "Administration", label: "Licence" },
] as const;

export type Permission = (typeof PERMISSIONS)[number]["key"];

export const ALL_PERMISSIONS: readonly Permission[] = PERMISSIONS.map((p) => p.key);
const KNOWN = new Set<string>(ALL_PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && KNOWN.has(value);
}

/** The role that always holds every permission (cannot be edited, so no one locks the system out). */
export const ADMIN_ROLE = "admin";

/** Permissions of a role: the stored grants, or all of them for the admin role. Unknown keys are ignored. */
export function effectivePermissions(roleId: string, granted: readonly string[]): Permission[] {
  if (roleId === ADMIN_ROLE) return [...ALL_PERMISSIONS];
  return ALL_PERMISSIONS.filter((p) => granted.includes(p));
}

/** A role with any of these must use MFA on the dashboard (PRD 8.3). */
export function requiresMfa(permissions: readonly string[]): boolean {
  return permissions.some((p) => p.startsWith("admin."));
}

/** Signed in, no specific permission. */
export const AUTHENTICATED = "authenticated" as const;

type Requirement = Permission | typeof AUTHENTICATED;

const HIERARCHY = ["/api/sites", "/api/areas", "/api/lines"];

/**
 * "METHOD /route/pattern" → required permission. The pattern is Fastify's
 * (`request.routeOptions.url`). HEAD counts as GET.
 */
export const ROUTE_PERMISSIONS: Record<string, Requirement> = {
  // Own session
  "POST /api/auth/ws-ticket": AUTHENTICATED,
  "POST /api/auth/mfa/enroll": AUTHENTICATED,
  "POST /api/auth/mfa/verify-enrollment": AUTHENTICATED,

  // Production
  "POST /api/work-orders": "work_orders.manage",
  "PATCH /api/work-orders/:id": "work_orders.manage",
  "PUT /api/work-orders/:id": "work_orders.manage",
  "POST /api/work-orders/bulk": "work_orders.manage",
  "PUT /api/work-orders/:id/schedule": "schedule.manage",
  "DELETE /api/work-orders/:id/schedule": "schedule.manage",
  "POST /api/work-order-assignments": "schedule.manage",
  "PUT /api/work-order-assignments/:id": "schedule.manage",
  "DELETE /api/work-order-assignments/:id": "schedule.manage",
  "POST /api/material-lots": "materials.receive",
  "PATCH /api/material-lots/:id": "materials.manage",
  "DELETE /api/material-lots/:id": "materials.manage",
  "POST /api/work-orders/:id/material-consumption": "materials.assign",
  "DELETE /api/work-orders/:id/material-consumption/:materialLotId": "materials.assign",

  // Quality
  "POST /api/fault-reports": "faults.report",
  "PUT /api/fault-reports/:id/review": "faults.review",
  "POST /api/downtime-periods/:id/explain": "downtime.explain",
  "POST /api/corrective-actions": "corrective.log",
  "PUT /api/corrective-actions/:id/sign-off": "corrective.sign_off",
  "POST /api/work-instructions": "instructions.manage",
  "POST /api/work-instructions/files": "instructions.manage",
  "POST /api/work-instructions/view": AUTHENTICATED,
  "GET /api/work-instructions/views/log": "instructions.view_log",

  // Maintenance
  "POST /api/maintenance-work-orders": "maintenance.manage",
  "PATCH /api/maintenance-work-orders/:id": "maintenance.manage",
  "PUT /api/maintenance-work-orders/:id": "maintenance.manage",
  "POST /api/maintenance-work-orders/:id/parts": "maintenance.manage",
  "POST /api/maintenance-work-orders/:id/labor": "maintenance.manage",
  "GET /api/users/assignable": "maintenance.manage",
  "GET /api/preventive-schedules": "maintenance.plan",
  "POST /api/preventive-schedules": "maintenance.plan",
  "DELETE /api/preventive-schedules/:id": "maintenance.plan",

  // Alerts
  "POST /api/alerts/:id/acknowledge": "alerts.acknowledge",
  "GET /api/alert-rules": "alerts.rules",
  "POST /api/alert-rules": "alerts.rules",
  "PUT /api/alert-rules/:id": "alerts.rules",
  "DELETE /api/alert-rules/:id": "alerts.rules",

  // Machines and plant configuration
  "POST /api/machine-registry": "admin.machines",
  "PATCH /api/machine-registry/:id": "admin.machines",
  "PUT /api/machine-registry/:id": "admin.machines",
  "POST /api/machine-registry/bulk": "admin.machines",
  "GET /api/machine-registry/:id/related": "admin.machines",
  "PUT /api/machine-registry/:id/micro-stop-threshold": "admin.machines",
  "PUT /api/machine-registry/:id/scheduling": "admin.machines",
  ...Object.fromEntries(
    HIERARCHY.flatMap((p) => [
      [`POST ${p}`, "admin.machines"],
      [`PATCH ${p}/:id`, "admin.machines"],
      [`DELETE ${p}/:id`, "admin.machines"],
    ]),
  ),
  "GET /api/status-definitions": "admin.machines",
  "POST /api/status-definitions": "admin.machines",
  "PATCH /api/status-definitions/:id": "admin.machines",
  "DELETE /api/status-definitions/:id": "admin.machines",
  "POST /api/fault-codes": "admin.machines",
  "DELETE /api/fault-codes/:id": "admin.machines",
  "GET /api/shift-patterns": "admin.machines",
  "POST /api/shift-patterns": "admin.machines",
  "DELETE /api/shift-patterns/:id": "admin.machines",
  "POST /api/shift-patterns/:id/shifts": "admin.machines",
  "DELETE /api/shift-pattern-shifts/:shiftId": "admin.machines",
  "GET /api/calendars": "admin.machines",
  "POST /api/calendars": "admin.machines",
  "PUT /api/calendars/:id": "admin.machines",
  "DELETE /api/calendars/:id": "admin.machines",

  // Edge nodes (the claim / heartbeat / release protocol is public: own token)
  "GET /api/edge-nodes": "admin.edge_nodes",
  "POST /api/edge-nodes": "admin.edge_nodes",
  "DELETE /api/edge-nodes/:id": "admin.edge_nodes",
  "POST /api/edge-nodes/:id/regenerate-token": "admin.edge_nodes",
  "POST /api/edge-nodes/:id/channels": "admin.edge_nodes",
  "DELETE /api/edge-node-channels/:channelId": "admin.edge_nodes",
  "PATCH /api/edge-node-channels/:channelId": "admin.edge_nodes",
  "GET /api/edge-nodes/:id/settings": "admin.edge_nodes",
  "PATCH /api/edge-nodes/:id/settings": "admin.edge_nodes",
  "POST /api/edge-nodes/:id/restart": "admin.edge_nodes",

  // Terminals
  "POST /api/terminal-uis": "admin.terminals",
  "PUT /api/terminal-uis/:id": "admin.terminals",
  "DELETE /api/terminal-uis/:id": "admin.terminals",
  "POST /api/terminal-uis/:id/pair": "admin.terminals",
  "DELETE /api/terminal-uis/:id/pair": "admin.terminals",

  // Users and roles
  "GET /api/users": "admin.users",
  "POST /api/users": "admin.users",
  "PATCH /api/users/:id": "admin.users",
  "POST /api/users/:id/pin": "admin.users",
  "DELETE /api/users/:id/pin": "admin.users",
  "POST /api/users/:id/reset-mfa": "admin.users",
  "GET /api/roles": "admin.users",
  "POST /api/roles": "admin.users",
  "PATCH /api/roles/:id": "admin.users",
  "DELETE /api/roles/:id": "admin.users",

  // Audit, licence
  "GET /api/audit-log": "admin.audit",
  "GET /api/audit-log/actions": "admin.audit",
  "POST /api/license/reload": "admin.license",
};

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * What a signed-in user needs for this route: a permission, AUTHENTICATED,
 * or "deny" (a write route nobody listed — closed until someone decides).
 */
export function requirementFor(method: string, routePattern: string | undefined): Requirement | "deny" {
  const m = method === "HEAD" ? "GET" : method.toUpperCase();
  if (!routePattern) return WRITE_METHODS.has(m) ? "deny" : AUTHENTICATED;
  const listed = ROUTE_PERMISSIONS[`${m} ${routePattern}`];
  if (listed) return listed;
  return WRITE_METHODS.has(m) ? "deny" : AUTHENTICATED;
}
