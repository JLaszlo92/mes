import { useEffect, useMemo, useState } from "react";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE } from "./api.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import { downloadCsv } from "./ui/csv.js";
import MachineEditorDrawer, { type EditorTarget, type NamedOption } from "./MachineEditorDrawer.js";
import { useScope } from "./scope.js";
import { notifyMasterDataChanged, readJsonOrThrow, useMasterDataVersion, type Machine, type PlantHierarchy } from "./master-data.js";

type StatusFilter = "active" | "inactive" | "all";

const EMPTY_HIERARCHY: PlantHierarchy = { sites: [], areas: [], lines: [] };

/**
 * Gépnyilvántartás: kereshető, szűrhető, rendezhető táblázat; tömeges
 * műveletek (aktiválás, deaktiválás, áthelyezés, CSV export); a szerkesztés
 * és a másolás oldalpanelben (MachineEditorDrawer).
 *
 * A szűrés kliensoldali — a teljes géplistát egyszer tölti le (néhány száz
 * gépig ez a gyorsabb). Minden mentés a szerveren egy tranzakció.
 */
export default function MachineRegistryPanel() {
  const { auth } = useAuth();
  const canEdit = auth?.role === "admin" || auth?.role === "manager";
  const masterDataVersion = useMasterDataVersion();
  const { isInScope, isFiltered: scopeFiltered, label: scopeLabel } = useScope();

  const [machines, setMachines] = useState<Machine[]>([]);
  const [hierarchy, setHierarchy] = useState<PlantHierarchy>(EMPTY_HIERARCHY);
  const [shiftPatterns, setShiftPatterns] = useState<NamedOption[]>([]);
  const [calendars, setCalendars] = useState<NamedOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [siteId, setSiteId] = useState("");
  const [areaId, setAreaId] = useState("");
  const [lineId, setLineId] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [moveTarget, setMoveTarget] = useState<{ areaId: string; lineId: string } | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      apiFetch(`${API_BASE}/api/machine-registry`).then((r) => readJsonOrThrow<Machine[]>(r)).then(setMachines),
      apiFetch(`${API_BASE}/api/plant-hierarchy`).then((r) => readJsonOrThrow<PlantHierarchy>(r)).then(setHierarchy),
      apiFetch(`${API_BASE}/api/shift-patterns`).then((r) => readJsonOrThrow<NamedOption[]>(r)).then(setShiftPatterns),
      apiFetch(`${API_BASE}/api/calendars`).then((r) => readJsonOrThrow<NamedOption[]>(r)).then(setCalendars),
    ])
      .then(() => setError(null))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [masterDataVersion]);

  const siteName = useMemo(() => new Map(hierarchy.sites.map((s) => [s.id, s.name])), [hierarchy]);
  const areaName = useMemo(() => new Map(hierarchy.areas.map((a) => [a.id, a.name])), [hierarchy]);
  const lineName = useMemo(() => new Map(hierarchy.lines.map((l) => [l.id, l.name])), [hierarchy]);
  const patternName = useMemo(() => new Map(shiftPatterns.map((p) => [p.id, p.name])), [shiftPatterns]);
  const calendarName = useMemo(() => new Map(calendars.map((c) => [c.id, c.name])), [calendars]);

  const filtered = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return machines.filter((m) => {
      if (!isInScope(m.id)) return false;
      if (status === "active" && !m.isActive) return false;
      if (status === "inactive" && m.isActive) return false;
      if (siteId && m.siteId !== siteId) return false;
      if (areaId && m.areaId !== areaId) return false;
      if (lineId && (lineId === "none" ? m.lineId !== null : m.lineId !== lineId)) return false;
      if (words.length === 0) return true;
      const haystack = [m.id, m.name, m.assetType, m.location, siteName.get(m.siteId), areaName.get(m.areaId), m.lineId ? lineName.get(m.lineId) : null]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [machines, query, status, siteId, areaId, lineId, siteName, areaName, lineName, isInScope]);

  // A kiszűrt gépek ne maradjanak kijelölve — a tömeges művelet csak arra
  // hasson, amit a felhasználó éppen lát.
  const visibleSelected = useMemo(() => {
    const visible = new Set(filtered.map((m) => m.id));
    return new Set([...selected].filter((id) => visible.has(id)));
  }, [filtered, selected]);

  const filterAreas = hierarchy.areas.filter((a) => !siteId || a.siteId === siteId);
  const filterLines = hierarchy.lines.filter((l) => (areaId ? l.areaId === areaId : filterAreas.some((a) => a.id === l.areaId)));
  const filtersActive = query !== "" || siteId !== "" || areaId !== "" || lineId !== "" || status !== "active";

  function clearFilters() {
    setQuery("");
    setSiteId("");
    setAreaId("");
    setLineId("");
    setStatus("active");
  }

  function replaceMachines(updated: Machine[]) {
    const byId = new Map(updated.map((m) => [m.id, m]));
    setMachines((prev) => {
      const next = prev.map((m) => byId.get(m.id) ?? m);
      for (const m of updated) if (!prev.some((p) => p.id === m.id)) next.push(m);
      return next;
    });
  }

  async function runBulk(body: Record<string, unknown>, verb: string) {
    const ids = [...visibleSelected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/machine-registry/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, ids }),
      });
      const result = await readJsonOrThrow<{ updated: number; machines: Machine[] }>(res);
      replaceMachines(result.machines);
      notifyMasterDataChanged(); // a hierarchia-panel géplétszámai is frissüljenek
      setSelected(new Set());
      setMoveTarget(null);
      const unchanged = ids.length - result.updated;
      setNotice(`${verb} ${result.updated} machine${result.updated === 1 ? "" : "s"}${unchanged > 0 ? ` (${unchanged} already up to date)` : ""}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
    }
  }

  async function toggleActive(m: Machine) {
    if (m.isActive && !window.confirm(`Deactivate ${m.name}? It keeps its history but disappears from selectors and scheduling.`)) return;
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/machine-registry/${encodeURIComponent(m.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !m.isActive }),
      });
      replaceMachines([await readJsonOrThrow<Machine>(res)]);
      setNotice(`${m.name} ${m.isActive ? "deactivated" : "activated"}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function exportCsv(rows: Machine[]) {
    downloadCsv(
      `machines-${new Date().toISOString().slice(0, 10)}.csv`,
      ["ID", "Name", "Type", "Site", "Area", "Line", "Ideal cycle (s)", "Micro-stop threshold (s)", "Shift pattern", "Calendar", "Active"],
      rows.map((m) => [
        m.id,
        m.name,
        m.assetType,
        siteName.get(m.siteId),
        areaName.get(m.areaId),
        m.lineId ? lineName.get(m.lineId) : "",
        m.idealCycleTimeSeconds,
        m.microStopThresholdSeconds,
        m.shiftPatternId ? patternName.get(m.shiftPatternId) : "",
        m.calendarId ? calendarName.get(m.calendarId) : "",
        m.isActive ? "yes" : "no",
      ]),
    );
  }

  const nameOf = (map: Map<string, string>, id: string | null) => (id ? map.get(id) ?? null : null);

  const columns: Column<Machine>[] = [
    {
      id: "name",
      header: "Machine",
      sortValue: (m) => m.name,
      cell: (m) => (
        <span>
          {m.name}
          <span className="ui-sub">{m.id}</span>
        </span>
      ),
    },
    { id: "type", header: "Type", sortValue: (m) => m.assetType, cell: (m) => m.assetType ?? "—" },
    { id: "site", header: "Site", sortValue: (m) => nameOf(siteName, m.siteId), cell: (m) => nameOf(siteName, m.siteId) ?? "—" },
    { id: "area", header: "Area", sortValue: (m) => nameOf(areaName, m.areaId), cell: (m) => nameOf(areaName, m.areaId) ?? "—" },
    { id: "line", header: "Line", sortValue: (m) => nameOf(lineName, m.lineId), cell: (m) => nameOf(lineName, m.lineId) ?? "—" },
    {
      id: "cycle",
      header: "Ideal cycle",
      align: "right",
      sortValue: (m) => m.idealCycleTimeSeconds,
      cell: (m) => (m.idealCycleTimeSeconds !== null ? `${m.idealCycleTimeSeconds} s` : "—"),
    },
    {
      id: "pattern",
      header: "Shift pattern",
      sortValue: (m) => nameOf(patternName, m.shiftPatternId),
      cell: (m) => nameOf(patternName, m.shiftPatternId) ?? "—",
    },
    { id: "calendar", header: "Calendar", sortValue: (m) => nameOf(calendarName, m.calendarId), cell: (m) => nameOf(calendarName, m.calendarId) ?? "—" },
    {
      id: "status",
      header: "Status",
      sortValue: (m) => (m.isActive ? 0 : 1),
      cell: (m) => (m.isActive ? "Active" : <span className="ui-pill">Deactivated</span>),
    },
  ];

  const moveLines = moveTarget ? hierarchy.lines.filter((l) => l.areaId === moveTarget.areaId) : [];

  return (
    <section className="ui-panel">
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Machines</h2>
        <span className="ui-panel-count num">{filtered.length === machines.length ? machines.length : `${filtered.length} of ${machines.length}`}</span>
        {scopeFiltered && <span className="ui-pill ui-pill-accent">Only {scopeLabel}</span>}
        <span className="ui-toolbar-spacer" />
        <button type="button" className="ui-btn" onClick={() => exportCsv(filtered)} disabled={filtered.length === 0}>
          Export CSV
        </button>
        {canEdit && (
          <button type="button" className="ui-btn ui-btn-primary" onClick={() => setEditor({ mode: "create" })} disabled={hierarchy.areas.length === 0}>
            Add machine
          </button>
        )}
      </div>

      <div className="ui-toolbar" role="search">
        <input
          className="ui-input ui-search"
          type="search"
          placeholder="Search name, ID, type, location…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search machines"
        />
        <select className="ui-select" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Status">
          <option value="active">Active</option>
          <option value="inactive">Deactivated</option>
          <option value="all">All statuses</option>
        </select>
        <select
          className="ui-select"
          value={siteId}
          onChange={(e) => {
            setSiteId(e.target.value);
            setAreaId("");
            setLineId("");
          }}
          aria-label="Site"
        >
          <option value="">All sites</option>
          {hierarchy.sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          className="ui-select"
          value={areaId}
          onChange={(e) => {
            setAreaId(e.target.value);
            setLineId("");
          }}
          aria-label="Area"
        >
          <option value="">All areas</option>
          {filterAreas.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select className="ui-select" value={lineId} onChange={(e) => setLineId(e.target.value)} aria-label="Line">
          <option value="">All lines</option>
          <option value="none">No line</option>
          {filterLines.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        {filtersActive && (
          <button type="button" className="ui-btn ui-btn-ghost" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      {canEdit && visibleSelected.size > 0 && (
        <div className="ui-bulkbar" aria-live="polite">
          <span className="ui-bulkbar-count num">{visibleSelected.size} selected</span>
          {moveTarget ? (
            <>
              <select className="ui-select" value={moveTarget.areaId} onChange={(e) => setMoveTarget({ areaId: e.target.value, lineId: "" })} aria-label="Move to area">
                {hierarchy.sites.map((s) => (
                  <optgroup key={s.id} label={s.name}>
                    {hierarchy.areas
                      .filter((a) => a.siteId === s.id)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
              <select className="ui-select" value={moveTarget.lineId} onChange={(e) => setMoveTarget({ ...moveTarget, lineId: e.target.value })} aria-label="Move to line">
                <option value="">No line</option>
                {moveLines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                disabled={bulkBusy}
                onClick={() => void runBulk({ action: "move", areaId: moveTarget.areaId, lineId: moveTarget.lineId || null }, "Moved")}
              >
                Move
              </button>
              <button type="button" className="ui-btn ui-btn-ghost" onClick={() => setMoveTarget(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="ui-btn" disabled={bulkBusy} onClick={() => void runBulk({ action: "activate" }, "Activated")}>
                Activate
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-danger"
                disabled={bulkBusy}
                onClick={() => {
                  if (window.confirm(`Deactivate ${visibleSelected.size} machine(s)? They keep their history but disappear from selectors and scheduling.`)) {
                    void runBulk({ action: "deactivate" }, "Deactivated");
                  }
                }}
              >
                Deactivate
              </button>
              <button
                type="button"
                className="ui-btn"
                disabled={bulkBusy || hierarchy.areas.length === 0}
                onClick={() => setMoveTarget({ areaId: hierarchy.areas[0]?.id ?? "", lineId: "" })}
              >
                Move to…
              </button>
              <button type="button" className="ui-btn" onClick={() => exportCsv(filtered.filter((m) => visibleSelected.has(m.id)))}>
                Export selected
              </button>
              <span className="ui-toolbar-spacer" />
              <button type="button" className="ui-btn ui-btn-ghost" onClick={() => setSelected(new Set())}>
                Clear selection
              </button>
            </>
          )}
        </div>
      )}

      {error && <p className="ui-message ui-message-error">{error}</p>}
      {notice && <p className="ui-message ui-message-info">{notice}</p>}

      {loading && machines.length === 0 ? (
        <p className="ui-message ui-message-info">Loading machines…</p>
      ) : (
        <DataTable
          ariaLabel="Machines"
          rows={filtered}
          columns={columns}
          getRowId={(m) => m.id}
          selected={canEdit ? visibleSelected : undefined}
          onSelectedChange={canEdit ? setSelected : undefined}
          onRowClick={(m) => setEditor({ mode: "edit", machine: m })}
          isDimmed={(m) => !m.isActive}
          initialSort={{ columnId: "name", dir: "asc" }}
          rowActions={
            canEdit
              ? (m) => (
                  <>
                    <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={() => setEditor({ mode: "create", copyOf: m })}>
                      Copy
                    </button>
                    <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={() => void toggleActive(m)}>
                      {m.isActive ? "Deactivate" : "Activate"}
                    </button>
                  </>
                )
              : undefined
          }
          emptyText={
            machines.length === 0 ? (
              canEdit ? "No machines yet. Add the first one with the machine ID its edge agent sends." : "No machines registered yet."
            ) : (
              <>
                No machines match these filters.{" "}
                <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={clearFilters}>
                  Clear filters
                </button>
              </>
            )
          }
        />
      )}

      {editor && (
        <MachineEditorDrawer
          key={editor.mode === "edit" ? editor.machine.id : `new-${editor.copyOf?.id ?? ""}`}
          target={editor}
          hierarchy={hierarchy}
          shiftPatterns={shiftPatterns}
          calendars={calendars}
          readOnly={!canEdit}
          onClose={() => setEditor(null)}
          onSaved={(machine, created) => {
            replaceMachines([machine]);
            notifyMasterDataChanged();
            setEditor(null);
            setNotice(created ? `${machine.name} created.` : `${machine.name} saved.`);
          }}
        />
      )}
    </section>
  );
}
