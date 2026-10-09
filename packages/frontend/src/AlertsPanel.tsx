import AlertDetailsDrawer from "./AlertDetailsDrawer.js";
import { notifyAlertsChanged } from "./alerts-live.js";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE } from "./api.js";
import { useScope } from "./scope.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import { formatDateTime, formatDuration } from "./ui/format.js";
import { readJsonOrThrow } from "./master-data.js";
import { alertTypeLabel, type Alert } from "./alert-types.js";

/**
 * Aktív (nyitott) riasztások táblázatban, 15 mp-enként frissítve. A
 * nyugtázatlanok elöl és pirossal — ez az egyetlen hely, ahol a riasztásszín
 * felületként jelenik meg. Nyugtázás egyenként vagy tömegesen; gépriasztásból
 * karbantartási munkarendelés nyitható.
 */
export default function AlertsPanel() {
  const { isInScope } = useScope();
  const { auth } = useAuth();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  /** Riasztások, amelyekhez ebben a munkamenetben már készült munkarendelés — a gomb ne duplikáljon. */
  const [ticketCreatedFor, setTicketCreatedFor] = useState<Set<string>>(new Set());
  const canCreateTicket = ["supervisor", "maintenance", "manager", "admin"].includes(auth?.role ?? "");

  function load() {
    apiFetch(`${API_BASE}/api/alerts`)
      .then((r) => readJsonOrThrow<Alert[]>(r))
      .then((list) => {
        setAlerts(list);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, []);

  const open = useMemo(() => alerts.filter((a) => !a.resolvedAt && isInScope(a.machineId)), [alerts, isInScope]);
  const detailsAlert = alerts.find((a) => a.id === detailsId) ?? null;
  const visibleSelected = useMemo(() => new Set([...selected].filter((id) => open.some((a) => a.id === id && !a.acknowledgedAt))), [selected, open]);

  async function acknowledge(ids: string[]) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // Nincs tömeges végpont; a nyugtázás riasztásonként független, így itt nincs részleges-mentés kockázat.
      const results = await Promise.all(
        ids.map((id) => apiFetch(`${API_BASE}/api/alerts/${encodeURIComponent(id)}/acknowledge`, { method: "POST" }).then((r) => r.ok)),
      );
      const failed = results.filter((ok) => !ok).length;
      setNotice(failed ? `${ids.length - failed} acknowledged, ${failed} failed.` : `${ids.length} acknowledged.`);
      setSelected(new Set());
      load();
      notifyAlertsChanged();
    } finally {
      setBusy(false);
    }
  }

  async function createTicket(a: Alert) {
    if (!a.machineId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/maintenance-work-orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machineId: a.machineId, title: `Investigate: ${a.message}`, sourceType: "alert", sourceId: a.id }),
      });
      await readJsonOrThrow<unknown>(res);
      setTicketCreatedFor((prev) => new Set(prev).add(a.id));
      setNotice(`Maintenance work order created for ${a.machineName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const now = Date.now();
  const columns: Column<Alert>[] = [
    {
      id: "state",
      header: "",
      sortValue: (a) => (a.acknowledgedAt ? 1 : 0),
      cell: (a) => (a.acknowledgedAt ? <span className="ui-pill">Acknowledged</span> : <span className="ui-pill ui-pill-alarm">New</span>),
    },
    { id: "machine", header: "Machine", sortValue: (a) => a.machineName, cell: (a) => a.machineName },
    { id: "type", header: "Type", sortValue: (a) => a.type, cell: (a) => alertTypeLabel(a.type) },
    { id: "message", header: "Message", cell: (a) => <span title={a.message}>{a.message}</span> },
    { id: "raised", header: "Raised", sortValue: (a) => a.raisedAt, cell: (a) => formatDateTime(a.raisedAt) },
    { id: "open", header: "Open for", align: "right", sortValue: (a) => -new Date(a.raisedAt).getTime(), cell: (a) => formatDuration((now - new Date(a.raisedAt).getTime()) / 1000) },
  ];

  return (
    <section className="ui-panel" style={{ marginTop: 8 }}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Active alerts</h2>
        <span className="ui-panel-count num">{open.length}</span>
      </div>

      {visibleSelected.size > 0 && (
        <div className="ui-bulkbar">
          <span className="ui-bulkbar-count num">{visibleSelected.size} selected</span>
          <button type="button" className="ui-btn ui-btn-primary" disabled={busy} onClick={() => void acknowledge([...visibleSelected])}>
            Acknowledge
          </button>
          <span className="ui-toolbar-spacer" />
          <button type="button" className="ui-btn ui-btn-ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}
      {error && <p className="ui-message ui-message-error">{error}</p>}
      {notice && <p className="ui-message ui-message-info">{notice}</p>}

      <DataTable
        ariaLabel="Active alerts"
        rows={open}
        columns={columns}
        getRowId={(a) => a.id}
        selected={visibleSelected}
        onSelectedChange={setSelected}
        isDimmed={(a) => !!a.acknowledgedAt}
        onRowClick={(a) => setDetailsId(a.id)}
        initialSort={{ columnId: "state", dir: "asc" }}
        rowActions={(a) => (
          <>
            {canCreateTicket && a.machineId && a.type === "machine_down" && !ticketCreatedFor.has(a.id) && (
              <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" disabled={busy} onClick={() => void createTicket(a)}>
                Create ticket
              </button>
            )}
            {!a.acknowledgedAt && (
              <button type="button" className="ui-btn ui-btn-small" disabled={busy} onClick={() => void acknowledge([a.id])}>
                Acknowledge
              </button>
            )}
          </>
        )}
        emptyText="No active alerts."
      />
      <p className="ui-field-hint">Resolved alerts are under Alerts → History. Click a row for the full text.</p>
      {detailsAlert && <AlertDetailsDrawer alert={detailsAlert} onClose={() => setDetailsId(null)} />}
    </section>
  );
}
