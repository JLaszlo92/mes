/** Users, roles and permissions: shared types and calls (Admin → Users, Admin → Roles). */
import { apiFetch, API_BASE } from "./api.js";
import { readJsonOrThrow } from "./master-data.js";

export interface PermissionDef {
  key: string;
  group: string;
  label: string;
}

export interface Role {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  isLocked: boolean;
  userCount: number;
  permissions: string[];
}

export interface UserRow {
  id: string;
  name: string;
  displayName: string | null;
  employeeNumber: string | null;
  email: string | null;
  role: string;
  roleName: string;
  isActive: boolean;
  createdAt: string;
  mfaEnabled: boolean;
  hasPassword: boolean;
  hasPin: boolean;
  pinSetAt: string | null;
  permissions: string[];
}

export async function loadRoles(): Promise<{ roles: Role[]; permissions: PermissionDef[] }> {
  return readJsonOrThrow(await apiFetch(`${API_BASE}/api/roles`));
}

export async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await apiFetch(`${API_BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return readJsonOrThrow<T>(res);
}

/** Permissions grouped in catalogue order. */
export function groupPermissions(defs: PermissionDef[]): [string, PermissionDef[]][] {
  const groups = new Map<string, PermissionDef[]>();
  for (const d of defs) groups.set(d.group, [...(groups.get(d.group) ?? []), d]);
  return [...groups.entries()];
}
