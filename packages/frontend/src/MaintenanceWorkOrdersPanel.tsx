import { useEffect, useMemo, useState } from "react";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE } from "./api.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import { downloadCsv } from "./ui/csv.js";
import { formatDateTime } from "./ui/format.js";
import { readJsonOrThrow, useMasterDataVersion, type Machine } from "./master-data.js";
import { useScope } from "./scope.js";
import MaintenanceDrawer, {
  MAINTENANCE_STATUS_LABEL,
  PRIORITY_LABEL,
  SOURCE_LABEL,
  type AssignableUser,
  type MaintenanceStatus,
  type MaintenanceTarget,
  type MaintenanceWorkOrder,
} from "./MaintenanceDrawer.js";

type StatusFilter = "open" | "all" | MaintenanceStatus;
type PlanFilter = "" | "planned" | "unplanned";

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

/**
 * Karbantartási munkarendelések táblázatban, ugyanazzal a mintával, mint a
 * gépek és a gyártási rendelések: keresés, szűrők, rendezés, CSV export,
 * részletek oldalpanelben. A tervezett ablak oszlopa a Gantt-integráció
 * előkészítése.
 */
export default function MaintenanceWorkOrdersPanel() {
  const { auth } = useAuth();
  const canEdit = auth?.role === "maintenance" || auth?.role === "manager" || auth?.role === "admin";
  const canLogParts = canEdit || auth?.role === "supervisor";
  const masterDataVersion = useMasterDataVersion();
  const { isInScope } = useScope();

  const [orders, setOrders] = useState<MaintenanceWorkOrder[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("open");
  const [machineFilter, setMachineFilter] = useState("");
  const [planFilter, setPlanFilter] = useState<PlanFilter>("");
  const [editor, setEditor] = useState<MaintenanceTarget | null>(null);

  function loadOrders() {
    return apiFetch(`${API_BASE}/api/maintenance-work-orders`)
      .then((r) => readJsonOrThrow<MaintenanceWorkOrder[]>(r))
      .then((list) => {
        setOrders(list);
        // A nyitott drawer a friss adatot mutassa (pl. munkaóra rögzítése után).
        setEditor((prev) => (prev?.mode === "edit" ? { mode: "edit", order: list.find((o) => o.id === prev.order.id) ?? prev.order } : prev));
      });
  }

  useEffect(() => {
    setLoading(true);
    const calls = [loadOrders(), apiFetch(`${API_BASE}/api/machine-registry?active=true`).then((r) => readJsonOrThrow<Machine[]>(r)).then(setMachines)];
    if (canLogParts) calls.push(apiFetch(`${API_BASE}/api/users/assignable`).then((r) => readJsonOrThrow<AssignableUser[]>(r)).then(setUsers));
    Promise.all(calls)
      .then(() => setError(null))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masterDataVersion]);

  const filtered = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return orders.filter((o) => {
      if (!isInScope(o.machineId)) return false;
      if (status === "open" && o.status === "closed") return false;
      if (status !== "open" && status !== "all" && o.status !== status) return false;
      if (machineFilter && o.machineId !== machineFilter) return false;
      if (planFilter === "planned" && !o.plannedStart) return false;
      if (planFilter === "unplanned" && o.plannedStart) return false;
      if (words.length === 0) return true;
      const haystack = [o.title, o.description, o.machineName, o.assignedToEmail, o.sourceType ? SOURCE_LABEL[o.sourceType] : null]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
  }, [orders, query, status, machineFilter, planFilter, isInScope]);

  const filtersActive = query !== "" || status !== "open" || machineFilter !== "" || planFilter !== "";
  function clearFilters() {
    setQuery("");
    setStatus("open");
    setMachineFilter("");
    setPlanFilter("");
  }

  // A gépszűrőben azok a gépek is szerepeljenek, amelyeken már van munka (deaktiváltak is).
  const machineOptions = useMemo(() => {
    const byId = new Map(machines.map((m) => [m.id, m.name]));
    for (const o of orders) if (!byId.has(o.machineId)) byId.set(o.machineId, o.machineName);
    return [...byId].sort((a, b) => a[1].localeCompare(b[1]));
  }, [machines, orders]);

  function exportCsv(rows: MaintenanceWorkOrder[]) {
    downloadCsv(
      `maintenance-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Title", "Machine", "Priority", "Status", "Assigned to", "Planned start", "Planned end", "Labor (h)", "Parts", "Source", "Created", "Closed"],
      rows.map((o) => [
        o.title,
        o.machineName,
        PRIORITY_LABEL[o.priority],
        MAINTENANCE_STATUS_LABEL[o.status],
        o.assignedToEmail,
        o.plannedStart,
        o.plannedEnd,
        o.laborHours,
        o.partsCount,
        o.sourceType ? SOURCE_LABEL[o.sourceType] ?? o.sourceType : "",
        o.createdAt,
        o.closedAt,
      ]),
    );
  }

  const columns: Column<MaintenanceWorkOrder>[] = [
    {
      id: "title",
      header: "Job",
      sortValue: (o) => o.title,
      cell: (o) => (
        <span>
          {o.title}
          <span className="ui-sub">{o.sourceType ? SOURCE_LABEL[o.sourceType] ?? o.sourceType : "Manual"}</span>
        </span>
      ),
    },
    { id: "machine", header: "Machine", sortValue: (o) => o.machineName, cell: (o) => o.machineName },
    {
      id: "priority",
      header: "Priority",
      sortValue: (o) => PRIORITY_RANK[o.priority],
      cell: (o) =>
        o.priority === "urgent" ? (
          <span className="ui-pill ui-pill-alarm">Urgent</span>
        ) : o.priority === "high" ? (
          <span className="ui-pill ui-pill-warning">High</span>
        ) : (
          PRIORITY_LABEL[o.priority]
        ),
    },
    {
      id: "status",
      header: "Status",
      sortValue: (o) => ["in_progress", "assigned", "open", "closed"].indexOf(o.status),
      cell: (o) => (o.status === "in_progress" ? <span className="ui-pill ui-pill-accent">In progress</span> : MAINTENANCE_STATUS_LABEL[o.status]),
    },
    { id: "assignee", header: "Assigned to", sortValue: (o) => o.assignedToEmail, cell: (o) => o.assignedToEmail ?? "—" },
    { id: "planned", header: "Planned", sortValue: (o) => o.plannedStart, cell: (o) => (o.plannedStart ? `${formatDateTime(o.plannedStart)} – ${formatDateTime(o.plannedEnd)}` : "—") },
    { id: "labor", header: "Labor", align: "right", sortValue: (o) => o.laborHours, cell: (o) => (o.laborHours ? `${o.laborHours.toLocaleString()} h` : "—") },
    { id: "created", header: "Created", sortValue: (o) => o.createdAt, cell: (o) => formatDateTime(o.createdAt) },
  ];

  return (
    <section className="ui-panel" style={{ marginTop: 8 }}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Maintenance work orders</h2>
        <span className="ui-panel-count num">{filtered.length === orders.length ? orders.length : `${filtered.length} of ${orders.length}`}</span>
        <span className="ui-toolbar-spacer" />
        <button type="button" className="ui-btn" onClick={() => exportCsv(filtered)} disabled={filtered.length === 0}>
          Export CSV
        </button>
        {canEdit && (
          <button type="button" className="ui-btn ui-btn-primary" onClick={() => setEditor({ mode: "create" })} disabled={machines.length === 0}>
            New work order
          </button>
        )}
      </div>

      <div className="ui-toolbar" role="search">
        <input
          className="ui-input ui-search"
          type="search"
          placeholder="Search job, machine, person…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search maintenance work orders"
        />
        <select className="ui-select" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Status">
          <option value="open">Not closed</option>
          {(Object.keys(MAINTENANCE_STATUS_LABEL) as MaintenanceStatus[]).map((s) => (
            <option key={s} value={s}>
              {MAINTENANCE_STATUS_LABEL[s]}
            </option>
          ))}
          <option value="all">All statuses</option>
        </select>
        <select className="ui-select" value={machineFilter} onChange={(e) => setMachineFilter(e.target.value)} aria-label="Machine">
          <option value="">All machines</option>
          {machineOptions.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select className="ui-select" value={planFilter} onChange={(e) => setPlanFilter(e.target.value as PlanFilter)} aria-label="Planning">
          <option value="">Planned or not</option>
          <option value="planned">Planned</option>
          <option value="unplanned">Not planned</option>
        </select>
        {filtersActive && (
          <button type="button" className="ui-btn ui-btn-ghost" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      {error && <p className="ui-message ui-message-error">{error}</p>}
      {notice && <p className="ui-message ui-message-info">{notice}</p>}

      {loading && orders.length === 0 ? (
        <p className="ui-message ui-message-info">Loading maintenance work orders…</p>
      ) : (
        <DataTable
          ariaLabel="Maintenance work orders"
          rows={filtered}
          columns={columns}
          getRowId={(o) => o.id}
          onRowClick={(o) => setEditor({ mode: "edit", order: o })}
          isDimmed={(o) => o.status === "closed"}
          initialSort={{ columnId: "priority", dir: "asc" }}
          emptyText={
            orders.length === 0 ? (
              "No maintenance work orders yet. They are also created from alerts, fault reports and preventive schedules."
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
        <MaintenanceDrawer
          key={editor.mode === "edit" ? editor.order.id : "new"}
          target={editor}
          machines={machines}
          users={users}
          canEdit={canEdit}
          canLogParts={canLogParts}
          onClose={() => setEditor(null)}
          onSaved={(order, kind) => {
            if (kind === "logged") {
              void loadOrders();
              return;
            }
            setOrders((prev) => (prev.some((o) => o.id === order.id) ? prev.map((o) => (o.id === order.id ? order : o)) : [order, ...prev]));
            if (kind === "created") {
              setEditor({ mode: "edit", order });
              setNotice(`"${order.title}" created.`);
            } else {
              setEditor(null);
              setNotice(`"${order.title}" saved.`);
            }
          }}
        />
      )}
    </section>
  );
}
