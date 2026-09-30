import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE } from "./api.js";
import { notifyMasterDataChanged, readJsonOrThrow, useMasterDataVersion, type PlantHierarchy } from "./master-data.js";

type Level = "site" | "area" | "line";

const PATH: Record<Level, string> = { site: "/api/sites", area: "/api/areas", line: "/api/lines" };
const PARENT_FIELD: Record<Level, "siteId" | "areaId" | null> = { site: null, area: "siteId", line: "areaId" };

interface Item {
  id: string;
  name: string;
  parentId: string | null;
  /** Rövid összefoglaló a név mellett, pl. "3 lines · 12 machines". */
  detail: string;
  /** Csak üres elem törölhető (a szerver is 409-cel utasítja el). */
  empty: boolean;
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Telephely → részleg → gyártósor karbantartása három oszlopban: egy
 * telephely kiválasztása mutatja a részlegeit, egy részlegé a sorait.
 * Átnevezés, áthelyezés (részleg másik telephelyre, sor másik részlegre — a
 * sor gépei vele mennek) és üres elem törlése.
 */
export default function PlantHierarchyPanel() {
  const { auth } = useAuth();
  const canEdit = auth?.role === "admin" || auth?.role === "manager";
  const version = useMasterDataVersion();
  const [hierarchy, setHierarchy] = useState<PlantHierarchy>({ sites: [], areas: [], lines: [] });
  const [siteId, setSiteId] = useState<string | null>(null);
  const [areaId, setAreaId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch(`${API_BASE}/api/plant-hierarchy`)
      .then((r) => readJsonOrThrow<PlantHierarchy>(r))
      .then((h) => {
        setHierarchy(h);
        // Érvényes kijelölés megtartása; különben az első elem.
        setSiteId((prev) => (prev && h.sites.some((s) => s.id === prev) ? prev : h.sites[0]?.id ?? null));
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [version]);

  const areas = hierarchy.areas.filter((a) => a.siteId === siteId);
  useEffect(() => {
    setAreaId((prev) => (prev && areas.some((a) => a.id === prev) ? prev : areas[0]?.id ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, hierarchy]);
  const lines = hierarchy.lines.filter((l) => l.areaId === areaId);

  async function mutate(method: "POST" | "PATCH" | "DELETE", level: Level, id: string | null, body?: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}${PATH[level]}${id ? `/${encodeURIComponent(id)}` : ""}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const result = await readJsonOrThrow<{ id?: string } | undefined>(res);
      notifyMasterDataChanged();
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  const siteItems: Item[] = hierarchy.sites.map((s) => ({
    id: s.id,
    name: s.name,
    parentId: null,
    detail: `${plural(s.areaCount, "area")}, ${plural(s.machineCount, "machine")}`,
    empty: s.areaCount === 0,
  }));
  const areaItems: Item[] = areas.map((a) => ({
    id: a.id,
    name: a.name,
    parentId: a.siteId,
    detail: `${plural(a.lineCount, "line")}, ${plural(a.machineCount, "machine")}`,
    empty: a.lineCount === 0 && a.machineCount === 0,
  }));
  const lineItems: Item[] = lines.map((l) => ({
    id: l.id,
    name: l.name,
    parentId: l.areaId,
    detail: plural(l.machineCount, "machine"),
    empty: l.machineCount === 0,
  }));

  const siteOptions = hierarchy.sites.map((s) => ({ id: s.id, name: s.name }));
  const areaOptions = hierarchy.areas.map((a) => ({
    id: a.id,
    name: `${hierarchy.sites.find((s) => s.id === a.siteId)?.name ?? "?"} / ${a.name}`,
  }));

  return (
    <section className="ui-panel">
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Sites, areas and lines</h2>
      </div>
      {error && <p className="ui-message ui-message-error">{error}</p>}
      <div className="ui-columns">
        <HierarchyColumn
          title="Sites"
          level="site"
          items={siteItems}
          selectedId={siteId}
          onSelect={setSiteId}
          canEdit={canEdit}
          busy={busy}
          addPlaceholder="New site"
          onAdd={async (name) => {
            const created = await mutate("POST", "site", null, { name });
            if (created?.id) setSiteId(created.id);
            return !!created;
          }}
          onSave={(id, changes) => mutate("PATCH", "site", id, changes).then(Boolean)}
          onDelete={(id) => mutate("DELETE", "site", id).then(() => undefined)}
        />
        <HierarchyColumn
          title="Areas"
          level="area"
          items={areaItems}
          selectedId={areaId}
          onSelect={setAreaId}
          canEdit={canEdit && siteId !== null}
          busy={busy}
          addPlaceholder="New area"
          emptyText={siteId ? "No areas at this site yet." : "Add a site first."}
          parentOptions={siteOptions}
          onAdd={async (name) => {
            const created = await mutate("POST", "area", null, { name, siteId });
            if (created?.id) setAreaId(created.id);
            return !!created;
          }}
          onSave={(id, changes) => mutate("PATCH", "area", id, changes).then(Boolean)}
          onDelete={(id) => mutate("DELETE", "area", id).then(() => undefined)}
        />
        <HierarchyColumn
          title="Lines"
          level="line"
          items={lineItems}
          selectedId={null}
          canEdit={canEdit && areaId !== null}
          busy={busy}
          addPlaceholder="New line"
          emptyText={areaId ? "No lines in this area. Machines can also belong to the area directly." : "Select an area."}
          parentOptions={areaOptions}
          onAdd={(name) => mutate("POST", "line", null, { name, areaId }).then(Boolean)}
          onSave={(id, changes) => mutate("PATCH", "line", id, changes).then(Boolean)}
          onDelete={(id) => mutate("DELETE", "line", id).then(() => undefined)}
        />
      </div>
    </section>
  );
}

function HierarchyColumn({
  title,
  level,
  items,
  selectedId,
  onSelect,
  canEdit,
  busy,
  addPlaceholder,
  emptyText = "Nothing here yet.",
  parentOptions,
  onAdd,
  onSave,
  onDelete,
}: {
  title: string;
  level: Level;
  items: Item[];
  selectedId: string | null;
  onSelect?: (id: string) => void;
  canEdit: boolean;
  busy: boolean;
  addPlaceholder: string;
  emptyText?: string;
  parentOptions?: { id: string; name: string }[];
  onAdd: (name: string) => Promise<boolean>;
  onSave: (id: string, changes: Record<string, string>) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string; parentId: string | null } | null>(null);
  const parentField = PARENT_FIELD[level];

  async function add(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    if (await onAdd(name)) setNewName("");
  }

  async function saveEdit(e: FormEvent, item: Item) {
    e.preventDefault();
    if (!editing) return;
    const changes: Record<string, string> = {};
    if (editing.name.trim() && editing.name.trim() !== item.name) changes.name = editing.name.trim();
    if (parentField && editing.parentId && editing.parentId !== item.parentId) changes[parentField] = editing.parentId;
    if (Object.keys(changes).length === 0 || (await onSave(item.id, changes))) setEditing(null);
  }

  return (
    <div className="ui-column">
      <div className="ui-column-head">{title}</div>
      <ul className="ui-column-list" role="listbox" aria-label={title}>
        {items.length === 0 && <li className="ui-field-hint" style={{ padding: 8 }}>{emptyText}</li>}
        {items.map((item) =>
          editing?.id === item.id ? (
            <li key={item.id} style={{ padding: 4 }}>
              <form onSubmit={(e) => void saveEdit(e, item)} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <input
                  className="ui-input"
                  autoFocus
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
                  aria-label={`${title} name`}
                />
                {parentOptions && (
                  <select
                    className="ui-select"
                    value={editing.parentId ?? ""}
                    onChange={(e) => setEditing({ ...editing, parentId: e.target.value })}
                    aria-label="Move to"
                  >
                    {parentOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
                <div style={{ display: "flex", gap: 4 }}>
                  <button type="submit" className="ui-btn ui-btn-small ui-btn-primary" disabled={busy}>
                    Save
                  </button>
                  <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                  <span style={{ flex: 1 }} />
                  <button
                    type="button"
                    className="ui-btn ui-btn-small ui-btn-ghost ui-btn-danger"
                    disabled={busy || !item.empty}
                    title={item.empty ? undefined : "Only empty items can be deleted"}
                    onClick={() => {
                      if (window.confirm(`Delete "${item.name}"?`)) void onDelete(item.id).then(() => setEditing(null));
                    }}
                  >
                    Delete
                  </button>
                </div>
              </form>
            </li>
          ) : (
            <li
              key={item.id}
              className="ui-column-item"
              role="option"
              aria-selected={selectedId === item.id}
              tabIndex={0}
              onClick={() => onSelect?.(item.id)}
              onKeyDown={(e) => e.key === "Enter" && onSelect?.(item.id)}
            >
              <span className="ui-column-item-name">
                {item.name}
                <span className="ui-sub">{item.detail}</span>
              </span>
              {canEdit && (
                <button
                  type="button"
                  className="ui-btn ui-btn-small ui-btn-ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing({ id: item.id, name: item.name, parentId: item.parentId });
                  }}
                >
                  Edit
                </button>
              )}
            </li>
          ),
        )}
      </ul>
      {canEdit && (
        <form className="ui-column-foot" onSubmit={(e) => void add(e)}>
          <input className="ui-input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={addPlaceholder} aria-label={addPlaceholder} />
          <button type="submit" className="ui-btn" disabled={busy || newName.trim() === ""}>
            Add
          </button>
        </form>
      )}
    </div>
  );
}
