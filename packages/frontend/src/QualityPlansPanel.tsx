import { useEffect, useMemo, useState } from "react";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE } from "./api.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import { formatDateTime } from "./ui/format.js";
import { usePolling } from "./ui/usePolling.js";
import QualityPlanDrawer, { type PlanTarget } from "./QualityPlanDrawer.js";
import { listPlans, type QualityPlan } from "./quality.js";

/**
 * Minőségellenőrzési tervek part-onként (táblázat, mint a munkautasításoknál).
 * Sorra kattintva szerkeszthető; a mentés új verzió. Szerkeszteni csak a
 * quality.plans jogosultsággal lehet (alapból: Quality supervisor).
 */
export default function QualityPlansPanel() {
  const { can } = useAuth();
  const canEdit = can("quality.plans");
  const [plans, setPlans] = useState<QualityPlan[]>([]);
  const [partNames, setPartNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showOff, setShowOff] = useState(false);
  const [editor, setEditor] = useState<PlanTarget | null>(null);

  function load() {
    return listPlans()
      .then((rows) => {
        setPlans(rows);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(() => {
    void load().finally(() => setLoading(false));
    apiFetch(`${API_BASE}/api/work-orders`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: { partName: string }[]) => setPartNames([...new Set(rows.map((r) => r.partName))].sort()))
      .catch(() => {});
  }, []);
  usePolling(() => void load(), 30_000, editor === null);

  const filtered = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return plans.filter((p) => {
      if (!showOff && !p.isActive) return false;
      const hay = [p.partName, p.notes, ...p.characteristics.map((c) => c.name)].filter(Boolean).join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [plans, query, showOff]);

  const columns: Column<QualityPlan>[] = [
    {
      id: "part",
      header: "Part",
      sortValue: (p) => p.partName,
      cell: (p) => (
        <span>
          {p.partName} {!p.isActive && <span className="ui-pill">Off</span>}
          <span className="ui-sub ui-cell-clip">{p.characteristics.map((c) => c.name).join(", ")}</span>
        </span>
      ),
    },
    { id: "version", header: "Version", align: "right", width: 80, sortValue: (p) => p.version, cell: (p) => `v${p.version}` },
    {
      id: "checks",
      header: "Checks",
      cell: (p) => (
        <span>
          {[
            p.firstPiece.enabled && `First piece${p.firstPiece.gatesCounting ? " (holds counting)" : ""}`,
            p.lastPiece.enabled && `Last piece${p.lastPiece.gatesCompletion ? " (holds completion)" : ""}`,
            p.spot.enabled &&
              `Spot ${[p.spot.everyParts && `every ${p.spot.everyParts} pcs`, p.spot.maxMinutes && `≤ ${p.spot.maxMinutes} min`].filter(Boolean).join(", ")}`,
          ]
            .filter(Boolean)
            .join(" · ") || <span className="ui-sub">None</span>}
        </span>
      ),
    },
    { id: "chars", header: "Measurements", align: "right", width: 120, sortValue: (p) => p.characteristics.length, cell: (p) => p.characteristics.length },
    { id: "orders", header: "Open orders", align: "right", width: 110, sortValue: (p) => p.openWorkOrders ?? 0, cell: (p) => p.openWorkOrders ?? 0 },
    {
      id: "updated",
      header: "Last changed",
      sortValue: (p) => p.createdAt,
      cell: (p) => (
        <span>
          {formatDateTime(p.createdAt)}
          <span className="ui-sub">{p.createdByName ?? "—"}</span>
        </span>
      ),
    },
  ];

  return (
    <section className="ui-panel" style={{ marginTop: 8 }}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Quality plans</h2>
        <span className="ui-panel-count num">{filtered.length}</span>
        <span className="ui-toolbar-spacer" />
        {canEdit && (
          <button type="button" className="ui-btn ui-btn-primary" onClick={() => setEditor({ mode: "create" })}>
            New quality plan
          </button>
        )}
      </div>
      <div className="ui-toolbar" role="search">
        <input className="ui-input ui-search" type="search" placeholder="Search part, measurement…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search quality plans" />
        <label className="ui-check">
          <input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> Show turned off
        </label>
      </div>
      {error && <p className="ui-message ui-message-error">{error}</p>}
      {notice && <p className="ui-message ui-message-info">{notice}</p>}
      {loading && plans.length === 0 ? (
        <p className="ui-message ui-message-info">Loading quality plans…</p>
      ) : (
        <DataTable
          paging={{ resetKey: [query, showOff] }}
          ariaLabel="Quality plans"
          rows={filtered}
          columns={columns}
          getRowId={(p) => p.partName}
          onRowClick={(p) => setEditor({ mode: "edit", plan: p })}
          initialSort={{ columnId: "part", dir: "asc" }}
          emptyText={plans.length === 0 ? (canEdit ? "No quality plans yet. Create one for a part." : "No quality plans yet.") : "No plans match."}
        />
      )}
      {editor && (
        <QualityPlanDrawer
          key={editor.mode === "edit" ? editor.plan.id : "new"}
          target={editor}
          canEdit={canEdit}
          partNames={partNames.filter((n) => !plans.some((p) => p.partName === n && p.isActive))}
          onClose={() => setEditor(null)}
          onSaved={(_plan, message) => {
            setEditor(null);
            setNotice(message);
            void load();
          }}
        />
      )}
    </section>
  );
}
