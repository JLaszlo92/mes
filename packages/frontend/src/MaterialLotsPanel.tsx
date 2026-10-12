import { useEffect, useMemo, useState } from "react";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE } from "./api.js";
import { readJsonOrThrow } from "./master-data.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import { downloadCsv } from "./ui/csv.js";
import { formatDate, formatDateTime } from "./ui/format.js";
import { usePolling } from "./ui/usePolling.js";
import MaterialLotDrawer, { type MaterialLotTarget } from "./MaterialLotDrawer.js";
import { takeOpenParam, type MaterialLot } from "./traceability.js";

type UseFilter = "" | "used" | "unused";

/**
 * Alapanyag-tételek: a beérkező szállítások nyilvántartása (nem készlet —
 * mennyiséget az ERP vezet). Táblázat a felhasználás számaival; sorra
 * kattintva szerkeszthető, és látszik, mely work orderekben és késztermék-
 * tételekben van. A work orderhez rendelés a work order oldalpanelén történik.
 */
export default function MaterialLotsPanel() {
  const { auth } = useAuth();
  const canEdit = auth?.role === "admin" || auth?.role === "manager";

  const [lots, setLots] = useState<MaterialLot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [useFilter, setUseFilter] = useState<UseFilter>("");
  const [editor, setEditor] = useState<MaterialLotTarget | null>(null);
  const [openId, setOpenId] = useState<string | null>(() => takeOpenParam());

  function load() {
    return apiFetch(`${API_BASE}/api/material-lots`)
      .then((r) => readJsonOrThrow<MaterialLot[]>(r))
      .then((rows) => {
        setLots(rows);
        setError(null);
        return rows;
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        return [] as MaterialLot[];
      });
  }

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, []);
  usePolling(() => void load(), 30_000, editor === null);

  // Opened from a lot ("Where else used"): show that material lot's drawer.
  useEffect(() => {
    if (!openId || loading) return;
    const lot = lots.find((l) => l.id === openId);
    if (lot) setEditor({ mode: "edit", lot });
    else setError("That material lot no longer exists.");
    setOpenId(null);
  }, [openId, loading, lots]);

  const materialNames = useMemo(() => [...new Set(lots.map((l) => l.materialName))].sort((a, b) => a.localeCompare(b)), [lots]);

  const filtered = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return lots.filter((l) => {
      if (useFilter === "used" && l.workOrderCount === 0) return false;
      if (useFilter === "unused" && l.workOrderCount > 0) return false;
      if (words.length === 0) return true;
      const haystack = [l.materialName, l.lotNumber, l.supplier].filter(Boolean).join(" ").toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
  }, [lots, query, useFilter]);

  const filtersActive = query !== "" || useFilter !== "";
  function clearFilters() {
    setQuery("");
    setUseFilter("");
  }

  function exportCsv() {
    downloadCsv(
      `material-lots-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Material", "Lot number", "Supplier", "Received", "Work orders", "Finished lots", "Last used", "Registered"],
      filtered.map((l) => [l.materialName, l.lotNumber, l.supplier, l.receivedAt, l.workOrderCount, l.finishedLotCount, l.lastUsedAt, l.createdAt]),
    );
  }

  const columns: Column<MaterialLot>[] = [
    { id: "material", header: "Material", sortValue: (l) => l.materialName, cell: (l) => l.materialName },
    { id: "lot", header: "Lot number", sortValue: (l) => l.lotNumber, cell: (l) => l.lotNumber },
    { id: "supplier", header: "Supplier", sortValue: (l) => l.supplier, cell: (l) => l.supplier ?? <span className="ui-sub">—</span> },
    { id: "received", header: "Received", sortValue: (l) => l.receivedAt, cell: (l) => formatDate(l.receivedAt) },
    { id: "orders", header: "Work orders", align: "right", width: 110, sortValue: (l) => l.workOrderCount, cell: (l) => l.workOrderCount },
    { id: "lots", header: "Finished lots", align: "right", width: 110, sortValue: (l) => l.finishedLotCount, cell: (l) => l.finishedLotCount },
    { id: "used", header: "Last used", sortValue: (l) => l.lastUsedAt, cell: (l) => formatDateTime(l.lastUsedAt) },
  ];

  return (
    <section className="ui-panel" style={{ marginTop: 8 }}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Material lots</h2>
        <span className="ui-panel-count num">{filtered.length === lots.length ? lots.length : `${filtered.length} of ${lots.length}`}</span>
        <span className="ui-toolbar-spacer" />
        <button type="button" className="ui-btn" onClick={exportCsv} disabled={filtered.length === 0}>
          Export CSV
        </button>
        <button type="button" className="ui-btn ui-btn-primary" onClick={() => setEditor({ mode: "create" })}>
          New material lot
        </button>
      </div>

      <div className="ui-toolbar" role="search">
        <input
          className="ui-input ui-search"
          type="search"
          placeholder="Search material, lot number, supplier…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search material lots"
        />
        <select className="ui-select" value={useFilter} onChange={(e) => setUseFilter(e.target.value as UseFilter)} aria-label="Use">
          <option value="">Used and unused</option>
          <option value="used">Used on work orders</option>
          <option value="unused">Not used yet</option>
        </select>
        {filtersActive && (
          <button type="button" className="ui-btn ui-btn-ghost" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      {error && <p className="ui-message ui-message-error">{error}</p>}
      {notice && <p className="ui-message ui-message-info">{notice}</p>}

      {loading && lots.length === 0 ? (
        <p className="ui-message ui-message-info">Loading material lots…</p>
      ) : (
        <DataTable
          paging={{ resetKey: [query, useFilter] }}
          ariaLabel="Material lots"
          rows={filtered}
          columns={columns}
          getRowId={(l) => l.id}
          onRowClick={(l) => setEditor({ mode: "edit", lot: l })}
          initialSort={{ columnId: "received", dir: "desc" }}
          emptyText={
            lots.length === 0 ? (
              "No material lots yet. Register each delivery when it arrives, then choose it on the work orders that use it."
            ) : (
              <>
                No material lots match these filters.{" "}
                <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={clearFilters}>
                  Clear filters
                </button>
              </>
            )
          }
        />
      )}

      {editor && (
        <MaterialLotDrawer
          key={editor.mode === "edit" ? editor.lot.id : "new"}
          target={editor}
          canEdit={canEdit}
          materialNames={materialNames}
          onClose={() => setEditor(null)}
          onSaved={(lot, created) => {
            setEditor(null);
            setNotice(created ? `${lot.materialName} · ${lot.lotNumber} added.` : `${lot.materialName} · ${lot.lotNumber} saved.`);
            void load();
          }}
          onDeleted={(lot) => {
            setEditor(null);
            setNotice(`${lot.materialName} · ${lot.lotNumber} deleted.`);
            void load();
          }}
        />
      )}
    </section>
  );
}
