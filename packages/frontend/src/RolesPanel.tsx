import { useEffect, useMemo, useState } from "react";
import { call, groupPermissions, loadRoles, type PermissionDef, type Role } from "./users-admin.js";

/**
 * Szerepek × jogosultságok mátrix. A változások helyben gyűlnek, a "Save"
 * szerepenként menti őket (PATCH). Az Admin oszlop zárolt: mindig minden
 * jogosultsága megvan, hogy senki ne zárhassa ki a rendszert önmagából.
 */
export default function RolesPanel() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [defs, setDefs] = useState<PermissionDef[]>([]);
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  async function load() {
    try {
      const r = await loadRoles();
      setRoles(r.roles);
      setDefs(r.permissions);
      setDraft(Object.fromEntries(r.roles.map((role) => [role.id, role.permissions])));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, []);

  const dirty = useMemo(
    () => roles.filter((r) => !r.isLocked && JSON.stringify([...(draft[r.id] ?? [])].sort()) !== JSON.stringify([...r.permissions].sort())),
    [roles, draft],
  );

  function toggle(roleId: string, key: string) {
    setDraft((d) => {
      const current = d[roleId] ?? [];
      return { ...d, [roleId]: current.includes(key) ? current.filter((k) => k !== key) : [...current, key] };
    });
    setNotice(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    const saved: string[] = [];
    try {
      for (const role of dirty) {
        await call(`/api/roles/${encodeURIComponent(role.id)}`, "PATCH", { permissions: draft[role.id] ?? [] });
        saved.push(role.name);
      }
      setNotice(`Saved: ${saved.join(", ")}. Signed-in users get the change within a few minutes, at the next page load at the latest.`);
    } catch (err) {
      setError(`${saved.length > 0 ? `Saved ${saved.join(", ")}, then: ` : ""}${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      await load();
    }
  }

  async function addRole() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      await call("/api/roles", "POST", { name, permissions: [] });
      setNewName("");
      setNotice(`Role ${name} added. Tick its permissions below and save.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function rename(role: Role) {
    const name = window.prompt(`New name for ${role.name}:`, role.name)?.trim();
    if (!name || name === role.name) return;
    setBusy(true);
    try {
      await call(`/api/roles/${encodeURIComponent(role.id)}`, "PATCH", { name });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(role: Role) {
    if (!window.confirm(`Delete the role ${role.name}?`)) return;
    setBusy(true);
    try {
      await call(`/api/roles/${encodeURIComponent(role.id)}`, "DELETE");
      setNotice(`Role ${role.name} deleted.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="ui-message ui-message-info">Loading roles…</p>;

  return (
    <section className="ui-panel" style={{ marginTop: 8 }}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Roles and permissions</h2>
        <span className="ui-panel-count num">{roles.length}</span>
        <span className="ui-toolbar-spacer" />
        <button type="button" className="ui-btn" disabled={busy || dirty.length === 0} onClick={() => void load()}>
          Discard changes
        </button>
        <button type="button" className="ui-btn ui-btn-primary" disabled={busy || dirty.length === 0} onClick={() => void save()}>
          {busy ? "Saving…" : dirty.length > 0 ? `Save ${dirty.length} role${dirty.length === 1 ? "" : "s"}` : "Save"}
        </button>
      </div>
      <p className="ui-field-hint" style={{ marginTop: 0 }}>
        A user sees and can do only what their role allows; the server checks the same list. Admin always has every permission.
      </p>

      <form
        className="ui-inline-form"
        style={{ marginBottom: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          void addRole();
        }}
      >
        <input className="ui-input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New role, e.g. Műszakvezető" aria-label="New role name" />
        <button type="submit" className="ui-btn" disabled={busy || newName.trim() === ""}>
          Add role
        </button>
      </form>

      {error && <p className="ui-message ui-message-error">{error}</p>}
      {notice && <p className="ui-message ui-message-info">{notice}</p>}

      <div className="ui-table-wrap">
        <table className="ui-table ui-matrix" aria-label="Permissions by role">
          <thead>
            <tr>
              <th>Permission</th>
              {roles.map((r) => (
                <th key={r.id} className="ui-matrix-role" scope="col">
                  <span>{r.name}</span>
                  <span className="ui-sub">
                    {r.userCount} user{r.userCount === 1 ? "" : "s"}
                  </span>
                  <span className="ui-matrix-actions">
                    <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={() => void rename(r)} disabled={busy}>
                      Rename
                    </button>
                    {!r.isSystem && (
                      <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={() => void remove(r)} disabled={busy || r.userCount > 0} title={r.userCount > 0 ? "Move its users to another role first" : undefined}>
                        Delete
                      </button>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groupPermissions(defs).map(([group, items]) => [
              <tr key={`g-${group}`} className="ui-matrix-group">
                <td colSpan={roles.length + 1}>{group}</td>
              </tr>,
              ...items.map((d) => (
                <tr key={d.key}>
                  <td title={d.key}>{d.label}</td>
                  {roles.map((r) => {
                    const on = r.isLocked || (draft[r.id] ?? []).includes(d.key);
                    const changed = !r.isLocked && on !== r.permissions.includes(d.key);
                    return (
                      <td key={r.id} className="ui-matrix-cell" data-changed={changed ? "true" : undefined}>
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={r.isLocked || busy}
                          onChange={() => toggle(r.id, d.key)}
                          aria-label={`${r.name}: ${d.label}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
    </section>
  );
}
