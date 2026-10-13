import { useEffect, useMemo, useState } from "react";
import DataTable, { type Column } from "./ui/DataTable.js";
import Pager from "./ui/Pager.js";
import { downloadCsv } from "./ui/csv.js";
import { formatDateTime } from "./ui/format.js";
import { useServerList } from "./ui/useServerList.js";
import { useScope } from "./scope.js";
import { MODE_LABEL, scrapApi, type ScrapAnalysis, type ScrapBooking, type ScrapByReason } from "./scrap.js";

type Range = "24h" | "7d" | "30d" | "90d";
const RANGE_HOURS: Record<Range, number> = { "24h": 24, "7d": 168, "30d": 720, "90d": 2160 };

const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })} %` : "—");

/**
 * Quality → Scrap: selejt ok és gép szerint egy időszakban (Pareto: a
 * legnagyobb ok felül, halmozott aránnyal), gépenkénti selejtarány, és a
 * terminálon lejelentett tételek (ki, mikor, mennyit, melyik rendelésre).
 */
export default function ScrapPanel() {
  const { isFiltered, machines, isInScope } = useScope();
  const [range, setRange] = useState<Range>("7d");
  const [query, setQuery] = useState("");
  const [analysis, setAnalysis] = useState<ScrapAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const t = setInterval(() => setMinute(Math.floor(Date.now() / 60_000)), 60_000);
    return () => clearInterval(t);
  }, []);
  const machineIds = useMemo(() => (isFiltered ? machines.filter((m) => isInScope(m.id)).map((m) => m.id).join(",") || "-" : undefined), [isFiltered, machines, isInScope]);
  const from = useMemo(() => new Date((minute * 60 - RANGE_HOURS[range] * 3600) * 1000).toISOString(), [range, minute]);

  useEffect(() => {
    let alive = true;
    scrapApi
      .analysis({ from, machineIds })
      .then((a) => alive && (setAnalysis(a), setError(null)))
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [from, machineIds]);

  const list = useServerList<ScrapBooking>("/api/scrap-bookings", { from, machineIds, q: query.trim() || undefined }, { refreshMs: 30_000 });

  const total = analysis ? analysis.totalScrap + analysis.totalGood : 0;
  const bookingColumns: Column<ScrapBooking>[] = [
    { id: "time", header: "Reported", cell: (b) => formatDateTime(b.bookedAt) },
    {
      id: "reason",
      header: "Reason",
      cell: (b) => (
        <span>
          {b.reasonName}
          <span className="ui-sub">{b.reasonCode}</span>
        </span>
      ),
    },
    { id: "qty", header: "Qty", align: "right", cell: (b) => <strong className="num">{b.quantity}</strong> },
    {
      id: "order",
      header: "Work order",
      cell: (b) =>
        b.orderNumber ? (
          <span>
            {b.orderNumber}
            <span className="ui-sub">{b.partName}</span>
          </span>
        ) : (
          "—"
        ),
    },
    { id: "machine", header: "Machine", cell: (b) => b.machineName ?? b.machineId },
    {
      id: "by",
      header: "By",
      cell: (b) => (
        <span>
          {b.bookedByName ?? "—"}
          <span className="ui-sub">{b.terminalName ?? ""}</span>
        </span>
      ),
    },
    { id: "mode", header: "Counted", cell: (b) => <span className="ui-sub" style={{ display: "inline" }}>{MODE_LABEL[b.mode]}</span> },
  ];

  return (
    <>
      <section className="ui-panel" style={{ marginTop: 8 }}>
        <div className="ui-panel-head">
          <h2 className="ui-panel-title">Scrap by reason</h2>
          {analysis && (
            <span className="ui-panel-count num">
              {analysis.totalScrap.toLocaleString()} scrap · {pct(analysis.totalScrap, total)} of {total.toLocaleString()} parts
            </span>
          )}
          <span className="ui-toolbar-spacer" />
          <select className="ui-select" value={range} onChange={(e) => setRange(e.target.value as Range)} aria-label="Time range">
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
          </select>
        </div>
        {error && <p className="ui-message ui-message-error">{error}</p>}
        {analysis && analysis.byReason.length === 0 && <p className="ui-message ui-message-info">No scrap in this period.</p>}
        {analysis && analysis.byReason.length > 0 && <Pareto rows={analysis.byReason} total={analysis.totalScrap} />}
      </section>

      {analysis && analysis.byMachine.some((m) => m.scrap > 0 || m.good > 0) && (
        <section className="ui-panel" style={{ marginTop: 12 }}>
          <div className="ui-panel-head">
            <h2 className="ui-panel-title">By machine</h2>
          </div>
          <DataTable
            ariaLabel="Scrap by machine"
            rows={analysis.byMachine}
            columns={[
              { id: "machine", header: "Machine", sortValue: (m) => m.machineName, cell: (m) => m.machineName },
              { id: "good", header: "Good", align: "right", sortValue: (m) => m.good, cell: (m) => <span className="num">{m.good.toLocaleString()}</span> },
              { id: "scrap", header: "Scrap", align: "right", sortValue: (m) => m.scrap, cell: (m) => <strong className="num">{m.scrap.toLocaleString()}</strong> },
              { id: "rate", header: "Scrap rate", align: "right", sortValue: (m) => (m.good + m.scrap > 0 ? m.scrap / (m.good + m.scrap) : 0), cell: (m) => <span className="num">{pct(m.scrap, m.good + m.scrap)}</span> },
              {
                id: "top",
                header: "Reasons",
                cell: (m) =>
                  m.byReason.length ? (
                    <span>
                      {m.byReason
                        .slice(0, 3)
                        .map((r) => `${r.name} ${r.quantity}`)
                        .join(" · ")}
                      {m.byReason.length > 3 ? ` · +${m.byReason.length - 3}` : ""}
                    </span>
                  ) : (
                    "—"
                  ),
              },
            ]}
            getRowId={(m) => m.machineId}
            initialSort={{ columnId: "scrap", dir: "desc" }}
            emptyText="No machines."
          />
        </section>
      )}

      <section className="ui-panel" style={{ marginTop: 12 }}>
        <div className="ui-panel-head">
          <h2 className="ui-panel-title">Reported at the terminals</h2>
          <span className="ui-panel-count num">{list.total.toLocaleString()}</span>
          <span className="ui-toolbar-spacer" />
          <button
            type="button"
            className="ui-btn"
            disabled={list.rows.length === 0}
            title="Exports the rows on this page"
            onClick={() =>
              downloadCsv(
                `scrap-reports-${new Date().toISOString().slice(0, 10)}.csv`,
                ["Reported", "Reason code", "Reason", "Quantity", "Work order", "Part", "Machine", "By", "Terminal", "Counted"],
                list.rows.map((b) => [b.bookedAt, b.reasonCode, b.reasonName, b.quantity, b.orderNumber, b.partName, b.machineName, b.bookedByName, b.terminalName, MODE_LABEL[b.mode]]),
              )
            }
          >
            Export page
          </button>
        </div>
        <div className="ui-toolbar" role="search">
          <input className="ui-input ui-search" type="search" placeholder="Work order, part, reason or machine…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search scrap reports" />
        </div>
        {list.error && <p className="ui-message ui-message-error">{list.error}</p>}
        <DataTable paging={false} ariaLabel="Scrap reports" rows={list.rows} columns={bookingColumns} getRowId={(b) => b.id} emptyText={list.loading ? "Loading…" : "No scrap reported at the terminals in this period."} />
        <Pager offset={list.offset} limit={list.limit} total={list.total} onChange={list.setPage} />
      </section>
    </>
  );
}

/** Horizontal Pareto bars: the biggest reason on top, the share and the running total beside each. */
export function Pareto({ rows, total }: { rows: ScrapByReason[]; total: number }) {
  const max = Math.max(1, ...rows.map((r) => r.quantity));
  let running = 0;
  return (
    <div className="sc-pareto" role="table" aria-label="Scrap by reason">
      <div className="sc-pareto-row sc-pareto-head" role="row">
        <span role="columnheader">Reason</span>
        <span role="columnheader" />
        <span role="columnheader" className="num">
          Share
        </span>
        <span role="columnheader" className="num">
          Cumulative
        </span>
      </div>
      {rows.map((r) => {
        running += r.quantity;
        return (
          <div key={r.code ?? "none"} className="sc-pareto-row" role="row" title={`${r.name}: ${r.quantity} (${r.booked} reported at a terminal, ${r.quantity - r.booked} from the machine)`}>
            <span role="cell" className="sc-pareto-name">
              {r.name}
              {r.code && <span className="ui-sub">{r.code}</span>}
            </span>
            <span role="cell" className="sc-pareto-bar">
              <span className="sc-bar" data-none={r.code ? undefined : "true"} style={{ width: `${(r.quantity / max) * 100}%` }} />
              <strong className="num">{r.quantity.toLocaleString()}</strong>
            </span>
            <span role="cell" className="num">
              {pct(r.quantity, total)}
            </span>
            <span role="cell" className="num ui-sub" style={{ display: "inline" }}>
              {pct(running, total)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
