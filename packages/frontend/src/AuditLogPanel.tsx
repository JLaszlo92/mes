import { useEffect, useMemo, useState } from "react";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE } from "./api.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import Drawer from "./ui/Drawer.js";
import Pager from "./ui/Pager.js";
import { downloadCsv } from "./ui/csv.js";
import { formatDateTime } from "./ui/format.js";
import { useServerList } from "./ui/useServerList.js";

interface AuditEntry {
  id: string;
  occurredAt: string;
  actorEmail: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
}

type RangePreset = "24h" | "7d" | "30d" | "all";
const RANGE_HOURS: Record<Exclude<RangePreset, "all">, number> = { "24h": 24, "7d": 168, "30d": 720 };

/** Biztonsági szempontból figyelendő műveletek — csak ezek kapnak színt. */
const ALARM_ACTIONS = new Set(["login_failed", "login_locked", "mfa_failed", "mfa_locked", "raw_events_dropped"]);

/**
 * Audit log szerveroldali szűréssel és lapozással: időszak, művelet, végrehajtó,
 * cél és szabad szöveg (a részletekben is keres). Sorra kattintva a teljes
 * bejegyzés, a változások előtte–utána értékeivel.
 */
export default function AuditLogPanel() {
  const { auth } = useAuth();
  const [range, setRange] = useState<RangePreset>("7d");
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [target, setTarget] = useState("");
  const [query, setQuery] = useState("");
  const [actions, setActions] = useState<{ action: string; count: number }[]>([]);
  const [open, setOpen] = useState<AuditEntry | null>(null);
  // A "from" percre kerekítve, hogy ne generáljon minden rendernél új kérést.
  const [nowMinute, setNowMinute] = useState(() => Math.floor(Date.now() / 60_000));

  useEffect(() => {
    const t = setInterval(() => setNowMinute(Math.floor(Date.now() / 60_000)), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    apiFetch(`${API_BASE}/api/audit-log/actions`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setActions)
      .catch(() => {});
  }, []);

  const from = useMemo(() => (range === "all" ? undefined : new Date((nowMinute * 60 - RANGE_HOURS[range] * 3600) * 1000).toISOString()), [range, nowMinute]);

  const list = useServerList<AuditEntry, { entries: AuditEntry[]; total: number }>(
    "/api/audit-log",
    { from, action: action || undefined, actor: actor.trim() || undefined, target: target.trim() || undefined, q: query.trim() || undefined },
    { toPage: (r) => ({ rows: r.entries, total: r.total }), enabled: auth?.role === "admin" },
  );

  if (auth?.role !== "admin") return null;

  const prefixes = [...new Set(actions.map((a) => a.action.split("_")[0]))].filter((p) => actions.filter((a) => a.action.startsWith(`${p}_`)).length > 1);
  const filtersActive = range !== "7d" || action !== "" || actor !== "" || target !== "" || query !== "";

  const columns: Column<AuditEntry>[] = [
    { id: "time", header: "Time", cell: (e) => formatDateTime(e.occurredAt) },
    { id: "action", header: "Action", cell: (e) => (ALARM_ACTIONS.has(e.action) ? <span className="ui-pill ui-pill-alarm">{e.action}</span> : e.action) },
    { id: "actor", header: "By", cell: (e) => e.actorEmail ?? <span className="ui-sub">system</span> },
    { id: "target", header: "Target", cell: (e) => e.target ?? "—" },
    { id: "ip", header: "IP", cell: (e) => e.ipAddress ?? "—" },
  ];

  return (
    <section className="ui-panel" style={{ marginTop: 8 }}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Audit log</h2>
        <span className="ui-panel-count num">{list.total.toLocaleString()}</span>
        <span className="ui-toolbar-spacer" />
        <button
          type="button"
          className="ui-btn"
          disabled={list.rows.length === 0}
          onClick={() =>
            downloadCsv(
              `audit-log-${new Date().toISOString().slice(0, 10)}.csv`,
              ["Time", "Action", "By", "Target", "IP", "Details"],
              list.rows.map((e) => [e.occurredAt, e.action, e.actorEmail, e.target, e.ipAddress, e.details ? JSON.stringify(e.details) : ""]),
            )
          }
          title="Exports the rows on this page"
        >
          Export page
        </button>
      </div>

      <div className="ui-toolbar" role="search">
        <input className="ui-input ui-search" type="search" placeholder="Search everything, including details…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search audit log" />
        <select className="ui-select" value={range} onChange={(e) => setRange(e.target.value as RangePreset)} aria-label="Time range">
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="all">All time</option>
        </select>
        <select className="ui-select" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action">
          <option value="">All actions</option>
          {prefixes.length > 0 && (
            <optgroup label="Groups">
              {prefixes.map((p) => (
                <option key={p} value={`${p}_*`}>
                  {p}_…
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Actions">
            {actions.map((a) => (
              <option key={a.action} value={a.action}>
                {a.action} ({a.count.toLocaleString()})
              </option>
            ))}
          </optgroup>
        </select>
        <input className="ui-input" style={{ width: 160 }} placeholder="By (email)" value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Actor email" />
        <input className="ui-input" style={{ width: 160 }} placeholder="Target id" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target id" />
        {filtersActive && (
          <button
            type="button"
            className="ui-btn ui-btn-ghost"
            onClick={() => {
              setRange("7d");
              setAction("");
              setActor("");
              setTarget("");
              setQuery("");
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {list.error && <p className="ui-message ui-message-error">{list.error}</p>}
      <DataTable
        ariaLabel="Audit log"
        rows={list.rows}
        columns={columns}
        getRowId={(e) => e.id}
        onRowClick={setOpen}
        emptyText={list.loading ? "Loading…" : "No entries match these filters."}
      />
      <Pager offset={list.offset} limit={list.limit} total={list.total} onChange={list.setPage} />

      {open && (
        <Drawer title={open.action} subtitle={formatDateTime(open.occurredAt)} onRequestClose={() => setOpen(null)}>
          <section className="ui-section">
            <dl className="ui-facts">
              <dt>By</dt>
              <dd>{open.actorEmail ?? "system"}</dd>
              <dt>Target</dt>
              <dd>
                {open.target ?? "—"}
                {open.target && (
                  <button
                    type="button"
                    className="ui-btn ui-btn-small ui-btn-ghost"
                    style={{ marginLeft: 8 }}
                    onClick={() => {
                      setTarget(open.target!);
                      setOpen(null);
                    }}
                  >
                    Show all for this target
                  </button>
                )}
              </dd>
              <dt>IP</dt>
              <dd>{open.ipAddress ?? "—"}</dd>
            </dl>
          </section>
          {open.details && <ChangesOrDetails details={open.details} />}
        </Drawer>
      )}
    </section>
  );
}

/** Ha a bejegyzésnek van `changes` diffje, táblázatban; a többi nyers JSON-ként. */
function ChangesOrDetails({ details }: { details: Record<string, unknown> }) {
  const changes = details.changes as Record<string, { from: unknown; to: unknown }> | undefined;
  const rest = Object.fromEntries(Object.entries(details).filter(([k]) => k !== "changes"));
  const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return (
    <>
      {changes && Object.keys(changes).length > 0 && (
        <section className="ui-section">
          <h3 className="ui-section-title">Changes</h3>
          <div className="ui-table-wrap" style={{ maxHeight: "none" }}>
            <table className="ui-table">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Before</th>
                  <th>After</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(changes).map(([field, c]) => (
                  <tr key={field}>
                    <td>{field}</td>
                    <td>{show(c?.from)}</td>
                    <td>{show(c?.to)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {Object.keys(rest).length > 0 && (
        <section className="ui-section">
          <h3 className="ui-section-title">Details</h3>
          <pre className="ui-code">{JSON.stringify(rest, null, 2)}</pre>
        </section>
      )}
    </>
  );
}
