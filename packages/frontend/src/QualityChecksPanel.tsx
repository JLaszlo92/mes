import { useEffect, useMemo, useState } from "react";
import DataTable, { type Column } from "./ui/DataTable.js";
import Drawer from "./ui/Drawer.js";
import Pager from "./ui/Pager.js";
import { downloadCsv } from "./ui/csv.js";
import { formatDateTime } from "./ui/format.js";
import { useServerList } from "./ui/useServerList.js";
import { useScope } from "./scope.js";
import QualityCheckDetail, { StatusPill } from "./QualityCheckDetail.js";
import { getCheckDetail, KIND_LABEL, STATUS_LABEL, TRIGGER_LABEL, type CheckDetail, type CheckKind, type QualityCheck } from "./quality.js";

/**
 * Minőségellenőrzések visszakövetése: szerveroldali lapozás és szűrés
 * (rendelés / part / gép szövegre, állapot, fajta), sorra kattintva minden
 * mérés minden próbálkozással. A rendelés oldalpanelje ugyanezt mutatja.
 */
export default function QualityChecksPanel() {
  const { isFiltered, machines, isInScope } = useScope();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const machineIds = useMemo(() => (isFiltered ? machines.filter((m) => isInScope(m.id)).map((m) => m.id).join(",") || "-" : undefined), [isFiltered, machines, isInScope]);
  const list = useServerList<QualityCheck>("/api/quality-checks", { q: query.trim() || undefined, status: status || undefined, kind: kind || undefined, machineIds }, { refreshMs: 15_000 });

  const columns: Column<QualityCheck>[] = [
    { id: "time", header: "Raised", cell: (c) => formatDateTime(c.createdAt) },
    {
      id: "order",
      header: "Work order",
      cell: (c) => (
        <span>
          {c.orderNumber}
          <span className="ui-sub">{c.partName}</span>
        </span>
      ),
    },
    {
      id: "kind",
      header: "Check",
      cell: (c) => (
        <span>
          {KIND_LABEL[c.kind]}
          <span className="ui-sub">{TRIGGER_LABEL[c.trigger] ?? c.trigger}</span>
        </span>
      ),
    },
    { id: "machine", header: "Machine", cell: (c) => c.machineName ?? "—" },
    { id: "result", header: "Measured", align: "right", cell: (c) => `${c.passedCount} / ${c.total}${c.failedAttempts ? ` · ${c.failedAttempts}✗` : ""}` },
    { id: "status", header: "Status", cell: (c) => <StatusPill status={c.status} overdue={c.overdue} /> },
    {
      id: "closed",
      header: "Closed",
      cell: (c) =>
        c.closedAt ? (
          <span>
            {formatDateTime(c.closedAt)}
            <span className="ui-sub">{c.closedByName ?? ""}</span>
          </span>
        ) : (
          "—"
        ),
    },
  ];
  const filtersActive = query !== "" || status !== "" || kind !== "";

  return (
    <section className="ui-panel" style={{ marginTop: 8 }}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Quality checks</h2>
        <span className="ui-panel-count num">{list.total.toLocaleString()}</span>
        <span className="ui-toolbar-spacer" />
        <button
          type="button"
          className="ui-btn"
          disabled={list.rows.length === 0}
          title="Exports the rows on this page"
          onClick={() =>
            downloadCsv(
              `quality-checks-${new Date().toISOString().slice(0, 10)}.csv`,
              ["Raised", "Work order", "Part", "Check", "Trigger", "Machine", "Passed", "Total", "Failed attempts", "Status", "Closed", "Closed by", "Release reason"],
              list.rows.map((c) => [c.createdAt, c.orderNumber, c.partName, KIND_LABEL[c.kind], c.trigger, c.machineName, c.passedCount, c.total, c.failedAttempts, STATUS_LABEL[c.status], c.closedAt, c.closedByName, c.releaseReason]),
            )
          }
        >
          Export page
        </button>
      </div>
      <div className="ui-toolbar" role="search">
        <input className="ui-input ui-search" type="search" placeholder="Work order, part or machine…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search quality checks" />
        <select className="ui-select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          <option value="active">Open or failed</option>
          {(Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select className="ui-select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Check">
          <option value="">All checks</option>
          {(Object.keys(KIND_LABEL) as CheckKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        {filtersActive && (
          <button
            type="button"
            className="ui-btn ui-btn-ghost"
            onClick={() => {
              setQuery("");
              setStatus("");
              setKind("");
            }}
          >
            Clear filters
          </button>
        )}
      </div>
      {list.error && <p className="ui-message ui-message-error">{list.error}</p>}
      <DataTable
        paging={false}
        ariaLabel="Quality checks"
        rows={list.rows}
        columns={columns}
        getRowId={(c) => c.id}
        onRowClick={(c) => setOpenId(c.id)}
        emptyText={list.loading ? "Loading…" : "No quality checks match these filters."}
      />
      <Pager offset={list.offset} limit={list.limit} total={list.total} onChange={list.setPage} />
      {openId && <CheckDrawer id={openId} onClose={() => setOpenId(null)} onChanged={list.reload} />}
    </section>
  );
}

export function CheckDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged?: () => void }) {
  const [check, setCheck] = useState<CheckDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    getCheckDetail(id)
      .then((c) => alive && setCheck(c))
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [id, tick]);
  return (
    <Drawer
      title={check ? `${KIND_LABEL[check.kind]} — ${check.orderNumber}` : "Quality check"}
      subtitle={check ? `${check.partName} · ${check.machineName ?? ""}` : undefined}
      onRequestClose={onClose}
    >
      {error && <p className="ui-message ui-message-error">{error}</p>}
      {check ? (
        <QualityCheckDetail
          check={check}
          onChanged={() => {
            setTick((n) => n + 1);
            onChanged?.();
          }}
        />
      ) : (
        !error && <p className="ui-field-hint">Loading…</p>
      )}
    </Drawer>
  );
}
