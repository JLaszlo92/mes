import { useEffect, useMemo, useState } from "react";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE } from "./api.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import { downloadCsv } from "./ui/csv.js";
import { formatDate, formatDateTime, formatDuration } from "./ui/format.js";
import { readJsonOrThrow, useMasterDataVersion, type Machine } from "./master-data.js";
import WorkOrderDrawer, { isLate, STATUS_LABEL, type WorkOrder, type WorkOrderStatus, type WorkOrderTarget } from "./WorkOrderDrawer.js";

type StatusFilter = "open" | "all" | WorkOrderStatus;
const OPEN: WorkOrderStatus[] = ["planned", "released", "in_progress"];

/**
 * Gyártási rendelések: kereshető, szűrhető táblázat ütemezési oszlopokkal
 * (gép, tervezett kezdés/befejezés), tömeges kiadás/törlés, CSV export.
 * Az ütemezés a rendelés oldalpanelén történik (a régi külön "Scheduling"
 * panel helyett) — ugyanazzal a végponttal és szabályokkal, mint a Gantt.
 */
export default function WorkOrdersPanel() {
  const { auth } = useAuth();
  const canEdit = auth?.role === "admin" || auth?.role === "manager";
  const masterDataVersion = useMasterDataVersion();

  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("open");
  const [machineFilter, setMachineFilter] = useState("");
  const [lateOnly, setLateOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<WorkOrderTarget | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  function loadWorkOrders() {
    return apiFetch(`${API_BASE}/api/work-orders`)
      .then((r) => readJsonOrThrow<WorkOrder[]>(r))
      .then(setWorkOrders);
  }

  useEffect(() => {
    setLoading(true);
    Promise.all([loadWorkOrders(), apiFetch(`${API_BASE}/api/machine-registry?active=true`).then((r) => readJsonOrThrow<Machine[]>(r)).then(setMachines)])
      .then(() => setError(null))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [masterDataVersion]);

  const filtered = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return workOrders.filter((wo) => {
      if (status === "open" && !OPEN.includes(wo.status)) return false;
      if (status !== "open" && status !== "all" && wo.status !== status) return false;
      if (machineFilter === "none" && wo.schedule) return false;
      if (machineFilter && machineFilter !== "none" && wo.schedule?.machineId !== machineFilter) return false;
      if (lateOnly && !isLate(wo)) return false;
      if (words.length === 0) return true;
      const haystack = [wo.orderNumber, wo.partName, wo.notes, wo.schedule?.machineName].filter(Boolean).join(" ").toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
  }, [workOrders, query, status, machineFilter, lateOnly]);

  const visibleSelected = useMemo(() => {
    const visible = new Set(filtered.map((w) => w.id));
    return new Set([...selected].filter((id) => visible.has(id)));
  }, [filtered, selected]);

  const lateCount = useMemo(() => workOrders.filter(isLate).length, [workOrders]);
  const filtersActive = query !== "" || status !== "open" || machineFilter !== "" || lateOnly;

  function clearFilters() {
    setQuery("");
    setStatus("open");
    setMachineFilter("");
    setLateOnly(false);
  }

  function replace(updated: WorkOrder[]) {
    const byId = new Map(updated.map((w) => [w.id, w]));
    setWorkOrders((prev) => {
      const next = prev.map((w) => byId.get(w.id) ?? w);
      for (const w of updated) if (!prev.some((p) => p.id === w.id)) next.unshift(w);
      return next;
    });
  }

  async function runBulk(action: "release" | "cancel") {
    const ids = [...visibleSelected];
    if (ids.length === 0) return;
    if (action === "cancel" && !window.confirm(`Cancel ${ids.length} work order(s)? Only planned and released orders are cancelled.`)) return;
    setBulkBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/work-orders/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids }),
      });
      const result = await readJsonOrThrow<{ updated: number; skipped: { id: string; status: string }[]; workOrders: WorkOrder[] }>(res);
      replace(result.workOrders);
      setSelected(new Set());
      const verb = action === "release" ? "Released" : "Cancelled";
      const skipped = result.skipped.length;
      const rule = action === "release" ? "only planned orders can be released" : "only planned and released orders can be cancelled";
      setNotice(`${verb} ${result.updated} work order${result.updated === 1 ? "" : "s"}.${skipped > 0 ? ` ${skipped} skipped: ${rule}.` : ""}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
    }
  }

  function exportCsv(rows: WorkOrder[]) {
    downloadCsv(
      `work-orders-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Order", "Part", "Quantity", "Cycle time (s)", "Due date", "Status", "Machine", "Planned start", "Planned end", "Planned working time (h)", "Completion", "Notes"],
      rows.map((w) => [
        w.orderNumber,
        w.partName,
        w.quantity,
        w.expectedCycleTimeSeconds,
        w.dueDate,
        STATUS_LABEL[w.status],
        w.schedule?.machineName,
        w.schedule?.plannedStart,
        w.schedule?.plannedEnd,
        w.schedule ? (w.schedule.plannedSeconds / 3600).toFixed(2) : "",
        w.completionMode,
        w.notes,
      ]),
    );
  }

  const columns: Column<WorkOrder>[] = [
    {
      id: "order",
      header: "Order",
      sortValue: (w) => w.orderNumber,
      cell: (w) => (
        <span>
          {w.orderNumber}
          <span className="ui-sub">{w.partName}</span>
        </span>
      ),
    },
    { id: "qty", header: "Quantity", align: "right", sortValue: (w) => w.quantity, cell: (w) => w.quantity.toLocaleString() },
    {
      id: "machine",
      header: "Machine",
      sortValue: (w) => w.schedule?.machineName ?? null,
      cell: (w) => w.schedule?.machineName ?? <span className="ui-sub">Not scheduled</span>,
    },
    { id: "start", header: "Planned start", sortValue: (w) => w.schedule?.plannedStart ?? null, cell: (w) => formatDateTime(w.schedule?.plannedStart) },
    { id: "end", header: "Planned end", sortValue: (w) => w.schedule?.plannedEnd ?? null, cell: (w) => formatDateTime(w.schedule?.plannedEnd) },
    {
      id: "work",
      header: "Working time",
      align: "right",
      sortValue: (w) => w.schedule?.plannedSeconds ?? null,
      cell: (w) => (w.schedule ? formatDuration(w.schedule.plannedSeconds) : "—"),
    },
    {
      id: "due",
      header: "Due",
      sortValue: (w) => w.dueDate,
      cell: (w) =>
        isLate(w) ? <span className="ui-pill ui-pill-warning">{formatDate(w.dueDate)}</span> : formatDate(w.dueDate),
    },
    {
      id: "status",
      header: "Status",
      sortValue: (w) => ["in_progress", "released", "planned", "completed", "cancelled"].indexOf(w.status),
      cell: (w) => (w.status === "in_progress" ? <span className="ui-pill ui-pill-accent">{STATUS_LABEL[w.status]}</span> : STATUS_LABEL[w.status]),
    },
  ];

  return (
    <section className="ui-panel" style={{ marginTop: 8 }}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Work orders</h2>
        <span className="ui-panel-count num">{filtered.length === workOrders.length ? workOrders.length : `${filtered.length} of ${workOrders.length}`}</span>
        <span className="ui-toolbar-spacer" />
        <button type="button" className="ui-btn" onClick={() => exportCsv(filtered)} disabled={filtered.length === 0}>
          Export CSV
        </button>
        {canEdit && (
          <button type="button" className="ui-btn ui-btn-primary" onClick={() => setEditor({ mode: "create" })}>
            New work order
          </button>
        )}
      </div>

      <div className="ui-toolbar" role="search">
        <input
          className="ui-input ui-search"
          type="search"
          placeholder="Search order, part, machine, notes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search work orders"
        />
        <select className="ui-select" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Status">
          <option value="open">Open</option>
          {(Object.keys(STATUS_LABEL) as WorkOrderStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
          <option value="all">All statuses</option>
        </select>
        <select className="ui-select" value={machineFilter} onChange={(e) => setMachineFilter(e.target.value)} aria-label="Machine">
          <option value="">All machines</option>
          <option value="none">Not scheduled</option>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <label className="ui-check">
          <input type="checkbox" checked={lateOnly} onChange={(e) => setLateOnly(e.target.checked)} />
          Late only{lateCount > 0 ? ` (${lateCount})` : ""}
        </label>
        {filtersActive && (
          <button type="button" className="ui-btn ui-btn-ghost" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      {canEdit && visibleSelected.size > 0 && (
        <div className="ui-bulkbar" aria-live="polite">
          <span className="ui-bulkbar-count num">{visibleSelected.size} selected</span>
          <button type="button" className="ui-btn" disabled={bulkBusy} onClick={() => void runBulk("release")}>
            Release
          </button>
          <button type="button" className="ui-btn ui-btn-danger" disabled={bulkBusy} onClick={() => void runBulk("cancel")}>
            Cancel orders
          </button>
          <button type="button" className="ui-btn" onClick={() => exportCsv(filtered.filter((w) => visibleSelected.has(w.id)))}>
            Export selected
          </button>
          <span className="ui-toolbar-spacer" />
          <button type="button" className="ui-btn ui-btn-ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      {error && <p className="ui-message ui-message-error">{error}</p>}
      {notice && <p className="ui-message ui-message-info">{notice}</p>}

      {loading && workOrders.length === 0 ? (
        <p className="ui-message ui-message-info">Loading work orders…</p>
      ) : (
        <DataTable
          ariaLabel="Work orders"
          rows={filtered}
          columns={columns}
          getRowId={(w) => w.id}
          selected={canEdit ? visibleSelected : undefined}
          onSelectedChange={canEdit ? setSelected : undefined}
          onRowClick={(w) => setEditor({ mode: "edit", workOrder: w })}
          isDimmed={(w) => w.status === "completed" || w.status === "cancelled"}
          initialSort={{ columnId: "start", dir: "asc" }}
          rowActions={
            canEdit
              ? (w) => (
                  <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={() => setEditor({ mode: "create", copyOf: w })}>
                    Copy
                  </button>
                )
              : undefined
          }
          emptyText={
            workOrders.length === 0 ? (
              canEdit ? "No work orders yet. Create one, then schedule it on a machine." : "No work orders yet."
            ) : (
              <>
                No work orders match these filters.{" "}
                <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={clearFilters}>
                  Clear filters
                </button>
              </>
            )
          }
        />
      )}

      {editor && (
        <WorkOrderDrawer
          key={editor.mode === "edit" ? editor.workOrder.id : `new-${editor.copyOf?.id ?? ""}`}
          target={editor}
          machines={machines}
          canEdit={canEdit}
          onClose={() => setEditor(null)}
          onSaved={(wo, kind) => {
            replace([wo]);
            if (kind === "created") {
              // Rögtön ütemezhető: a drawer szerkesztő módban nyílik újra.
              setEditor({ mode: "edit", workOrder: wo });
              setNotice(`${wo.orderNumber} created. You can schedule it now.`);
            } else if (kind === "scheduled") {
              setEditor({ mode: "edit", workOrder: wo });
              setNotice(wo.schedule ? `${wo.orderNumber} scheduled on ${wo.schedule.machineName}.` : `${wo.orderNumber} unscheduled.`);
            } else {
              setEditor(null);
              setNotice(`${wo.orderNumber} saved.`);
            }
          }}
        />
      )}
    </section>
  );
}
