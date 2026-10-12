import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import Drawer from "./ui/Drawer.js";
import Field from "./ui/Field.js";
import { formatDate } from "./ui/format.js";
import { ApiError } from "./master-data.js";
import { call, groupPermissions, loadRoles, type PermissionDef, type Role, type UserRow } from "./users-admin.js";

type StatusFilter = "active" | "inactive" | "all";
type Target = { mode: "create" } | { mode: "edit"; user: UserRow };

/**
 * Felhasználók és dolgozók. Egy sor lehet terminál-dolgozó (név, törzsszám,
 * PIN), dashboard-felhasználó (e-mail, jelszó) vagy mindkettő; a szerep
 * dönti el, mit tehet.
 */
export default function UsersPanel() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissionDefs, setPermissionDefs] = useState<PermissionDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [editor, setEditor] = useState<Target | null>(null);

  async function load() {
    try {
      const [u, r] = await Promise.all([call<UserRow[]>("/api/users", "GET"), loadRoles()]);
      setUsers(u);
      setRoles(r.roles);
      setPermissionDefs(r.permissions);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return users.filter((u) => {
      if (status === "active" && !u.isActive) return false;
      if (status === "inactive" && u.isActive) return false;
      if (roleFilter && u.role !== roleFilter) return false;
      const haystack = [u.name, u.employeeNumber, u.email, u.roleName].filter(Boolean).join(" ").toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
  }, [users, query, roleFilter, status]);

  const filtersActive = query !== "" || roleFilter !== "" || status !== "active";
  function clearFilters() {
    setQuery("");
    setRoleFilter("");
    setStatus("active");
  }

  const columns: Column<UserRow>[] = [
    {
      id: "name",
      header: "Name",
      sortValue: (u) => u.name,
      cell: (u) => (
        <span>
          {u.name}
          <span className="ui-sub">{u.employeeNumber ? `#${u.employeeNumber}` : "—"}</span>
        </span>
      ),
    },
    { id: "role", header: "Role", sortValue: (u) => u.roleName, cell: (u) => u.roleName },
    {
      id: "dashboard",
      header: "Dashboard sign-in",
      sortValue: (u) => u.email,
      cell: (u) =>
        u.hasPassword ? (
          <span>
            {u.email}
            <span className="ui-sub">{u.mfaEnabled ? "MFA on" : "MFA not set up"}</span>
          </span>
        ) : (
          <span className="ui-sub">Terminal only</span>
        ),
    },
    {
      id: "pin",
      header: "Terminal code",
      sortValue: (u) => (u.hasPin ? 1 : 0),
      cell: (u) => (u.hasPin ? <span>Set<span className="ui-sub">{formatDate(u.pinSetAt?.slice(0, 10))}</span></span> : <span className="ui-sub">None</span>),
    },
    { id: "status", header: "Status", sortValue: (u) => (u.isActive ? 0 : 1), cell: (u) => (u.isActive ? "Active" : <span className="ui-pill">Inactive</span>) },
  ];

  return (
    <section className="ui-panel" style={{ marginTop: 8 }}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Users</h2>
        <span className="ui-panel-count num">{filtered.length === users.length ? users.length : `${filtered.length} of ${users.length}`}</span>
        <span className="ui-toolbar-spacer" />
        <button type="button" className="ui-btn ui-btn-primary" onClick={() => setEditor({ mode: "create" })}>
          New user
        </button>
      </div>
      <div className="ui-toolbar" role="search">
        <input className="ui-input ui-search" type="search" placeholder="Search name, number, e-mail…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search users" />
        <select className="ui-select" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label="Role">
          <option value="">All roles</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <select className="ui-select" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Status">
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="all">All</option>
        </select>
        {filtersActive && (
          <button type="button" className="ui-btn ui-btn-ghost" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>
      {error && <p className="ui-message ui-message-error">{error}</p>}
      {notice && <p className="ui-message ui-message-info">{notice}</p>}
      {loading && users.length === 0 ? (
        <p className="ui-message ui-message-info">Loading users…</p>
      ) : (
        <DataTable
          ariaLabel="Users"
          paging={{ resetKey: [query, roleFilter, status] }}
          rows={filtered}
          columns={columns}
          getRowId={(u) => u.id}
          onRowClick={(u) => setEditor({ mode: "edit", user: u })}
          isDimmed={(u) => !u.isActive}
          initialSort={{ columnId: "name", dir: "asc" }}
          emptyText={users.length === 0 ? "No users yet." : "No users match these filters."}
        />
      )}
      {editor && (
        <UserDrawer
          key={editor.mode === "edit" ? editor.user.id : "new"}
          target={editor}
          roles={roles}
          permissionDefs={permissionDefs}
          onClose={() => setEditor(null)}
          onChanged={(u, message, keepOpen) => {
            setUsers((prev) => (prev.some((p) => p.id === u.id) ? prev.map((p) => (p.id === u.id ? u : p)) : [u, ...prev]));
            setNotice(message);
            setEditor(keepOpen ? { mode: "edit", user: u } : null);
          }}
        />
      )}
    </section>
  );
}

interface Draft {
  displayName: string;
  employeeNumber: string;
  role: string;
  isActive: boolean;
  email: string;
  password: string;
}

function UserDrawer({
  target,
  roles,
  permissionDefs,
  onClose,
  onChanged,
}: {
  target: Target;
  roles: Role[];
  permissionDefs: PermissionDef[];
  onClose: () => void;
  onChanged: (user: UserRow, message: string, keepOpen: boolean) => void;
}) {
  const { auth } = useAuth();
  const creating = target.mode === "create";
  const user = target.mode === "edit" ? target.user : undefined;
  const [initial] = useState<Draft>(() => ({
    displayName: user?.displayName ?? "",
    employeeNumber: user?.employeeNumber ?? "",
    role: user?.role ?? "operator",
    isActive: user?.isActive ?? true,
    email: user?.email ?? "",
    password: "",
  }));
  const [draft, setDraft] = useState(initial);
  const [signIn, setSignIn] = useState(user?.hasPassword ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [newPin, setNewPin] = useState<string | null>(null);
  const isSelf = !!user && auth?.userId === user.id;

  const changed = JSON.stringify(draft) !== JSON.stringify(initial) || signIn !== (user?.hasPassword ?? false);
  const role = roles.find((r) => r.id === draft.role);
  const fieldError = (f: string) => (error?.field === f ? error.message : undefined);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setError(null);
  }

  function requestClose() {
    if (busy) return;
    if (changed && !window.confirm(creating ? "Discard this new user?" : "Discard unsaved changes?")) return;
    onClose();
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        displayName: draft.displayName.trim() || null,
        employeeNumber: draft.employeeNumber.trim() || null,
        role: draft.role,
        isActive: draft.isActive,
      };
      if (signIn) {
        body.email = draft.email.trim() || null;
        if (draft.password || !user?.hasPassword) body.password = draft.password || null;
      } else if (creating || user?.hasPassword) {
        body.email = null;
        body.password = null;
      }
      if (creating) {
        if (!signIn) {
          delete body.email;
          delete body.password;
        }
        const created = await call<UserRow>("/api/users", "POST", body);
        onChanged(created, `${created.name} created. Generate a terminal code for them below if they work at a terminal.`, true);
      } else {
        const before: Record<string, unknown> = {
          displayName: initial.displayName.trim() || null,
          employeeNumber: initial.employeeNumber.trim() || null,
          role: initial.role,
          isActive: initial.isActive,
          email: initial.email || null,
        };
        const diff = Object.fromEntries(Object.entries(body).filter(([k, v]) => k === "password" || before[k] !== v));
        if (Object.keys(diff).length === 0) return onClose();
        const updated = await call<UserRow>(`/api/users/${encodeURIComponent(user!.id)}`, "PATCH", diff);
        onChanged(updated, `${updated.name} saved.`, false);
      }
    } catch (err) {
      setError(err instanceof ApiError ? { message: err.message, field: err.field } : { message: String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function pinAction(kind: "generate" | "remove") {
    if (!user || busy) return;
    if (kind === "generate" && user.hasPin && !window.confirm(`Give ${user.name} a new code? The old one stops working at once.`)) return;
    if (kind === "remove" && !window.confirm(`Remove ${user.name}'s terminal code? They can no longer work at a terminal.`)) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === "generate") {
        const { pin } = await call<{ pin: string }>(`/api/users/${encodeURIComponent(user.id)}/pin`, "POST");
        setNewPin(pin);
        onChanged({ ...user, hasPin: true, pinSetAt: new Date().toISOString() }, `New terminal code for ${user.name}.`, true);
      } else {
        await call(`/api/users/${encodeURIComponent(user.id)}/pin`, "DELETE");
        setNewPin(null);
        onChanged({ ...user, hasPin: false, pinSetAt: null }, `${user.name}'s terminal code removed.`, true);
      }
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function resetMfa() {
    if (!user || busy || !window.confirm(`Reset ${user.name}'s MFA? They set it up again at the next sign-in.`)) return;
    setBusy(true);
    try {
      await call(`/api/users/${encodeURIComponent(user.id)}/reset-mfa`, "POST");
      onChanged({ ...user, mfaEnabled: false }, `${user.name}'s MFA was reset.`, true);
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  const formId = "user-form";
  const terminalPermissions = (role?.permissions ?? []).filter((p) => p.startsWith("terminal."));

  return (
    <Drawer
      title={creating ? "New user" : user!.name}
      subtitle={creating ? "A worker at the terminal, a dashboard user, or both." : user!.roleName}
      onRequestClose={requestClose}
      footer={
        <>
          <span className="ui-field-hint" style={{ flex: 1 }}>
            {!creating && changed ? "Unsaved changes" : ""}
          </span>
          <button type="button" className="ui-btn" onClick={requestClose} disabled={busy}>
            {creating ? "Cancel" : "Close"}
          </button>
          <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy || (!creating && !changed)}>
            {busy ? "Saving…" : creating ? "Create user" : "Save changes"}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={save} noValidate>
        <fieldset disabled={busy} style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
          {error && !error.field && <p className="ui-message ui-message-error">{error.message}</p>}
          <section className="ui-section">
            <h3 className="ui-section-title">Person</h3>
            <div className="ui-grid-2">
              <Field label="Name" error={fieldError("displayName")}>
                <input className="ui-input" value={draft.displayName} onChange={(e) => set("displayName", e.target.value)} placeholder="Kovács János" />
              </Field>
              <Field label="Employee number" error={fieldError("employeeNumber")}>
                <input className="ui-input" value={draft.employeeNumber} onChange={(e) => set("employeeNumber", e.target.value)} placeholder="1042" />
              </Field>
              <Field label="Role" error={fieldError("role")} hint={isSelf ? "Your own role: you cannot take away your permission to manage users." : undefined}>
                <select className="ui-select" value={draft.role} onChange={(e) => set("role", e.target.value)}>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {!creating && (
              <label className="ui-check" style={{ marginTop: 12 }}>
                <input type="checkbox" checked={draft.isActive} disabled={isSelf} onChange={(e) => set("isActive", e.target.checked)} />
                Active (an inactive user cannot sign in or use a terminal code)
              </label>
            )}
            {fieldError("isActive") && <p className="ui-field-error">{fieldError("isActive")}</p>}
          </section>

          <section className="ui-section">
            <h3 className="ui-section-title">Dashboard sign-in</h3>
            <label className="ui-check">
              <input type="checkbox" checked={signIn} onChange={(e) => setSignIn(e.target.checked)} />
              Can sign in to the dashboard (e-mail and password)
            </label>
            {signIn && (
              <div className="ui-grid-2" style={{ marginTop: 12 }}>
                <Field label="E-mail" error={fieldError("email")}>
                  <input className="ui-input" type="email" autoComplete="off" value={draft.email} onChange={(e) => set("email", e.target.value)} />
                </Field>
                <Field
                  label={user?.hasPassword ? "New password" : "Password"}
                  error={fieldError("password")}
                  hint={user?.hasPassword ? "Leave empty to keep the current one. A new password signs them out everywhere." : "At least 10 characters. Tell it to the user in person."}
                >
                  <input className="ui-input" type="password" autoComplete="new-password" value={draft.password} onChange={(e) => set("password", e.target.value)} />
                </Field>
              </div>
            )}
            {!signIn && user?.hasPassword && <p className="ui-field-hint">Saving removes their dashboard sign-in (e-mail, password and MFA).</p>}
            {user?.hasPassword && user.mfaEnabled && (
              <button type="button" className="ui-btn ui-btn-small" style={{ marginTop: 12 }} onClick={() => void resetMfa()}>
                Reset MFA
              </button>
            )}
          </section>
        </fieldset>
      </form>

      <section className="ui-section">
        <h3 className="ui-section-title">Terminal code</h3>
        {creating ? (
          <p className="ui-field-hint" style={{ margin: 0 }}>
            Create the user first; then the system can generate their 5-digit code.
          </p>
        ) : (
          <>
            {newPin ? (
              <div className="ui-pin-reveal" role="status">
                <span className="ui-pin-digits num">{newPin}</span>
                <span className="ui-field-hint">Give this code to {user!.name} now. It is shown only once; it is not stored readable anywhere.</span>
              </div>
            ) : (
              <p className="ui-field-hint" style={{ marginTop: 0 }}>
                {user!.hasPin ? `A code was set on ${formatDate(user!.pinSetAt?.slice(0, 10))}.` : "No code yet: they cannot do anything at a terminal."} The code is personal: everything done with it is recorded under their name.
              </p>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="ui-btn" disabled={busy || !user!.isActive} onClick={() => void pinAction("generate")}>
                {user!.hasPin ? "Generate a new code" : "Generate code"}
              </button>
              {user!.hasPin && (
                <button type="button" className="ui-btn ui-btn-ghost" disabled={busy} onClick={() => void pinAction("remove")}>
                  Remove code
                </button>
              )}
            </div>
            {user!.hasPin && terminalPermissions.length === 0 && (
              <p className="ui-message ui-message-error" style={{ marginTop: 8 }}>
                The role {role?.name} has no terminal permission, so this code cannot do anything at a terminal.
              </p>
            )}
          </>
        )}
      </section>

      {role && (
        <section className="ui-section">
          <h3 className="ui-section-title">What {role.name} can do</h3>
          {role.permissions.length === 0 ? (
            <p className="ui-field-hint" style={{ margin: 0 }}>
              Read only: sees the dashboard, changes nothing.
            </p>
          ) : (
            groupPermissions(permissionDefs.filter((d) => role.permissions.includes(d.key))).map(([group, defs]) => (
              <div key={group} style={{ marginBottom: 8 }}>
                <div className="ui-field-label">{group}</div>
                <ul className="ui-perm-list">
                  {defs.map((d) => (
                    <li key={d.key}>{d.label}</li>
                  ))}
                </ul>
              </div>
            ))
          )}
          <p className="ui-field-hint" style={{ margin: 0 }}>
            Change what a role can do under Admin → Roles and permissions.
          </p>
        </section>
      )}
    </Drawer>
  );
}
