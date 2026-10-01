import { useMemo, useState } from "react";
import { useScope } from "./scope.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import Pager from "./ui/Pager.js";
import { formatDateTime, formatDuration } from "./ui/format.js";
import { useServerList } from "./ui/useServerList.js";
import { alertTypeLabel, type Alert } from "./alert-types.js";

type Status = "all" | "open" | "resolved";

/** Riasztás-előzmény szerveroldali lapozással; a hatókör gépei szerint szűr (a rendszerriasztások mindig benne). */
export default function AlertHistoryPanel() {
  const { isFiltered, machines, isInScope } = useScope();
  const [status, setStatus] = useState<Status>("all");
  const [days, setDays] = useState("30");

  const machineIds = useMemo(() => (isFiltered ? machines.filter((m) => isInScope(m.id)).map((m) => m.id).join(",") || "-" : undefined), [isFiltered, machines, isInScope]);
  const from = useMemo(() => (days === "all" ? undefined : new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - Number(days) * 86_400_000).toISOString()), [days]);
  const list = useServerList<Alert>("/api/alerts/history", { status, machineIds, from });

  const columns: Column<Alert>[] = [
    { id: "raised", header: "Raised", cell: (a) => formatDateTime(a.raisedAt) },
    { id: "machine", header: "Machine", cell: (a) => a.machineName },
    { id: "type", header: "Type", cell: (a) => alertTypeLabel(a.type) },
    { id: "message", header: "Message", cell: (a) => <span title={a.message}>{a.message}</span> },
    {
      id: "duration",
      header: "Duration",
      align: "right",
      cell: (a) => (a.resolvedAt ? formatDuration((new Date(a.resolvedAt).getTime() - new Date(a.raisedAt).getTime()) / 1000) : <span className="ui-pill ui-pill-alarm">Open</span>),
    },
    { id: "ack", header: "Acknowledged", cell: (a) => (a.acknowledgedAt ? formatDateTime(a.acknowledgedAt) : "—") },
  ];

  return (
    <section className="ui-panel" style={{ marginTop: 8 }}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Alert history</h2>
        <span className="ui-panel-count num">{list.total.toLocaleString()}</span>
      </div>
      <div className="ui-toolbar">
        <select className="ui-select" value={status} onChange={(e) => setStatus(e.target.value as Status)} aria-label="Status">
          <option value="all">Open and resolved</option>
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
        </select>
        <select className="ui-select" value={days} onChange={(e) => setDays(e.target.value)} aria-label="Period">
          <option value="1">Last 24 hours</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="all">All time</option>
        </select>
      </div>
      {list.error && <p className="ui-message ui-message-error">{list.error}</p>}
      <DataTable ariaLabel="Alert history" rows={list.rows} columns={columns} getRowId={(a) => a.id} emptyText={list.loading ? "Loading…" : "No alerts in this period."} />
      <Pager offset={list.offset} limit={list.limit} total={list.total} onChange={list.setPage} />
    </section>
  );
}
