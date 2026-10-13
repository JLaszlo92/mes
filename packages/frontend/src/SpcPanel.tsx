import { useEffect, useMemo, useState } from "react";
import DataTable, { type Column } from "./ui/DataTable.js";
import { downloadCsv } from "./ui/csv.js";
import { formatDateTime } from "./ui/format.js";
import { usePolling } from "./ui/usePolling.js";
import { useScope } from "./scope.js";
import { ControlChart, Histogram, type RefLine } from "./SpcCharts.js";
import { CheckDrawer } from "./QualityChecksPanel.js";
import {
  fmtIndex,
  fmtValue,
  getSpcSeries,
  getSpcSummary,
  GRADE_LABEL,
  KIND_LABEL,
  SIGNAL_LABEL,
  type CapabilityGrade,
  type SpcSeries,
  type SpcSummary,
} from "./quality.js";

type Range = "7d" | "30d" | "90d" | "365d";
const RANGE_DAYS: Record<Range, number> = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 };

function GradePill({ grade, reliable, stable }: { grade: CapabilityGrade; reliable: boolean; stable: boolean }) {
  if (grade === "unknown") return <span className="ui-sub">—</span>;
  const cls = grade === "not_capable" ? "ui-pill ui-pill-alarm" : grade === "marginal" ? "ui-pill ui-pill-warning" : "ui-pill";
  return (
    <span>
      <span className={cls}>{GRADE_LABEL[grade]}</span> {!stable && <span className="ui-pill ui-pill-warning">Not stable</span>}
      {!reliable && <span className="ui-sub">few values — indicative</span>}
    </span>
  );
}

const keyOf = (s: Pick<SpcSummary, "partName" | "name">) => `${s.partName}\u0000${s.name}`;

/**
 * SPC és folyamatképesség (Quality → SPC): minden mért jellemzőre (part +
 * mérés neve) a Cp/Cpk/Pp/Ppk és a jelzések egy táblázatban; egy sorra
 * kattintva az I-MR kártya, a hisztogram és az értékek.
 */
export default function SpcPanel() {
  const { isFiltered, machines, isInScope } = useScope();
  const [range, setRange] = useState<Range>("30d");
  const [kind, setKind] = useState("");
  const [attempts, setAttempts] = useState<"all" | "first">("all");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<SpcSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dayStamp, setDayStamp] = useState(() => Math.floor(Date.now() / 60_000));

  const machineIds = useMemo(() => (isFiltered ? machines.filter((m) => isInScope(m.id)).map((m) => m.id).join(",") || "-" : undefined), [isFiltered, machines, isInScope]);
  const params = useMemo(
    () => ({ from: new Date((dayStamp * 60 - RANGE_DAYS[range] * 86400) * 1000).toISOString(), kinds: kind || undefined, attempts, machineIds }),
    [range, kind, attempts, machineIds, dayStamp],
  );

  useEffect(() => {
    let alive = true;
    getSpcSummary(params)
      .then((r) => {
        if (!alive) return;
        setRows(r);
        setError(null);
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [params]);
  usePolling(() => setDayStamp(Math.floor(Date.now() / 60_000)), 60_000, true);

  const filtered = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (rows ?? []).filter((r) => words.every((w) => `${r.partName} ${r.name}`.toLowerCase().includes(w)));
  }, [rows, query]);

  const columns: Column<SpcSummary>[] = [
    {
      id: "char",
      header: "Measurement",
      sortValue: (r) => `${r.partName} ${r.name}`,
      cell: (r) => (
        <span>
          {r.name}
          <span className="ui-sub">{r.partName}</span>
        </span>
      ),
    },
    {
      id: "limits",
      header: "Limits",
      cell: (r) => (
        <span className="num">
          {fmtValue(r.lsl)} … {fmtValue(r.usl)}
          {r.unit ? ` ${r.unit}` : ""}
        </span>
      ),
    },
    { id: "n", header: "n", align: "right", width: 60, sortValue: (r) => r.n, cell: (r) => r.n },
    { id: "mean", header: "Mean", align: "right", sortValue: (r) => r.mean ?? 0, cell: (r) => <span className="num">{fmtValue(r.mean)}</span> },
    { id: "cpk", header: "Cpk", align: "right", width: 70, sortValue: (r) => r.capability.cpk ?? -99, cell: (r) => <strong className="num">{fmtIndex(r.capability.cpk)}</strong> },
    { id: "ppk", header: "Ppk", align: "right", width: 70, sortValue: (r) => r.capability.ppk ?? -99, cell: (r) => <span className="num">{fmtIndex(r.capability.ppk)}</span> },
    { id: "grade", header: "Capability", sortValue: (r) => ["not_capable", "marginal", "capable", "unknown"].indexOf(r.grade), cell: (r) => <GradePill grade={r.grade} reliable={r.reliable} stable={r.stable} /> },
    {
      id: "signals",
      header: "Out of spec / signals",
      align: "right",
      sortValue: (r) => r.outOfSpec * 1000 + r.signalPoints,
      cell: (r) => (
        <span className="num">
          {r.outOfSpec > 0 ? <span className="ui-pill ui-pill-alarm">{r.outOfSpec}</span> : 0} / {r.signalPoints > 0 ? <span className="ui-pill ui-pill-warning">{r.signalPoints}</span> : 0}
        </span>
      ),
    },
    { id: "last", header: "Last", sortValue: (r) => r.lastAt ?? "", cell: (r) => formatDateTime(r.lastAt) },
  ];

  const current = filtered.find((r) => keyOf(r) === selected) ?? null;

  return (
    <>
      <section className="ui-panel" style={{ marginTop: 8 }}>
        <div className="ui-panel-head">
          <h2 className="ui-panel-title">SPC and capability</h2>
          <span className="ui-panel-count num">{filtered.length}</span>
        </div>
        <div className="ui-toolbar" role="search">
          <input className="ui-input ui-search" type="search" placeholder="Part or measurement…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search measurements" />
          <select className="ui-select" value={range} onChange={(e) => setRange(e.target.value as Range)} aria-label="Time range">
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
            <option value="365d">Last 12 months</option>
          </select>
          <select className="ui-select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Checks">
            <option value="">All checks</option>
            <option value="first_piece">First piece</option>
            <option value="last_piece">Last piece</option>
            <option value="spot">Spot checks</option>
          </select>
          <select className="ui-select" value={attempts} onChange={(e) => setAttempts(e.target.value as "all" | "first")} aria-label="Attempts">
            <option value="all">Every measurement</option>
            <option value="first">First attempts only</option>
          </select>
        </div>
        <p className="ui-field-hint" style={{ margin: "0 0 8px" }}>
          Judged on the lower of Cpk and Ppk: ≥ 1.33 capable, 1.00–1.33 marginal, below 1.00 not capable. Cp / Cpk use the short-term spread (moving range), Pp / Ppk the overall spread; "Not stable" means a control rule was broken, so the indices only describe the past. Limits are the part's current quality plan.
        </p>
        {error && <p className="ui-message ui-message-error">{error}</p>}
        <DataTable
          paging={{ resetKey: [query, range, kind, attempts] }}
          ariaLabel="Capability by measurement"
          rows={filtered}
          columns={columns}
          getRowId={keyOf}
          onRowClick={(r) => setSelected(keyOf(r) === selected ? null : keyOf(r))}
          initialSort={{ columnId: "cpk", dir: "asc" }}
          emptyText={rows === null ? "Loading…" : "No measured values in this period. Values come from the quality checks at the terminals (measured values only, not OK / not OK)."}
        />
      </section>
      {current && <SpcDetail key={keyOf(current)} summary={current} params={params} onClose={() => setSelected(null)} />}
    </>
  );
}

function SpcDetail({ summary, params, onClose }: { summary: SpcSummary; params: Record<string, string | undefined>; onClose: () => void }) {
  const [series, setSeries] = useState<SpcSeries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [openCheck, setOpenCheck] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getSpcSeries({ ...params, partName: summary.partName, name: summary.name })
      .then((s) => alive && setSeries(s))
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [params, summary.partName, summary.name]);

  const unit = summary.unit ? ` ${summary.unit}` : "";
  const s = series?.summary ?? summary;
  const st = series?.stats;
  const refsI: RefLine[] = [];
  if (s.usl !== null) refsI.push({ y: s.usl, label: `USL ${fmtValue(s.usl)}`, tone: "spec" });
  if (s.lsl !== null) refsI.push({ y: s.lsl, label: `LSL ${fmtValue(s.lsl)}`, tone: "spec" });
  if (st?.ucl != null) refsI.push({ y: st.ucl, label: `UCL ${fmtValue(st.ucl)}`, tone: "control" });
  if (st?.lcl != null) refsI.push({ y: st.lcl, label: `LCL ${fmtValue(st.lcl)}`, tone: "control" });
  if (st) refsI.push({ y: st.mean, label: `x̄ ${fmtValue(st.mean)}`, tone: "center" });
  const refsMr: RefLine[] = [];
  if (st?.mrBar != null) refsMr.push({ y: st.mrBar, label: `MR̄ ${fmtValue(st.mrBar)}`, tone: "center" });
  if (st?.mrUcl != null) refsMr.push({ y: st.mrUcl, label: `UCL ${fmtValue(st.mrUcl)}`, tone: "control" });
  refsMr.push({ y: 0, label: "", tone: "nominal" });

  const pts = series?.points ?? [];
  const dateLabel = (i: number) => {
    const p = pts[i];
    return p ? new Date(p.at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  };
  const tip = (i: number, what: "value" | "mr") => {
    const p = pts[i]!;
    return (
      <>
        <strong className="num">
          {what === "value" ? `${fmtValue(p.value)}${unit}` : `MR ${fmtValue(p.mr)}${unit}`}
        </strong>
        {!p.passed && what === "value" && <span className="ui-pill ui-pill-alarm">Out of tolerance</span>}
        <span className="ui-sub">
          {formatDateTime(p.at)} · {p.orderNumber} · {KIND_LABEL[p.kind]}
          {p.attempt > 1 ? ` · attempt ${p.attempt}` : ""}
        </span>
        <span className="ui-sub">
          {p.machineName ?? "—"} · {p.measuredByName ?? "—"}
        </span>
        {p.signals.length > 0 && <span className="spc-tip-signal">◆ {p.signals.map((r) => SIGNAL_LABEL[r]).join("; ")}</span>}
      </>
    );
  };

  return (
    <section className="ui-panel spc-detail" style={{ marginTop: 12 }} aria-label={`SPC ${s.name}`}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">
          {s.name} <span className="ui-sub" style={{ display: "inline" }}>{s.partName}</span>
        </h2>
        <span className="ui-toolbar-spacer" />
        <button type="button" className="ui-btn ui-btn-ghost" onClick={() => setShowTable((v) => !v)} disabled={!series}>
          {showTable ? "Hide values" : "Show values"}
        </button>
        <button
          type="button"
          className="ui-btn"
          disabled={!series}
          onClick={() =>
            downloadCsv(
              `spc-${s.partName}-${s.name}-${new Date().toISOString().slice(0, 10)}.csv`.replace(/[^\w.-]+/g, "_"),
              ["Measured at", "Value", "Unit", "Moving range", "In tolerance", "LSL", "USL", "Check", "Attempt", "Work order", "Machine", "Measured by", "Signals"],
              pts.map((p) => [p.at, p.value, s.unit, p.mr, p.passed ? "yes" : "no", p.lsl, p.usl, KIND_LABEL[p.kind], p.attempt, p.orderNumber, p.machineName, p.measuredByName, p.signals.join(" ")]),
            )
          }
        >
          Export CSV
        </button>
        <button type="button" className="ui-btn ui-btn-ghost" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="spc-tiles">
        <Tile label="Values" value={String(s.n)} sub={s.reliable ? undefined : "fewer than 25 — indicative"} />
        <Tile label="Mean" value={`${fmtValue(s.mean)}${unit}`} sub={s.nominal !== null ? `nominal ${fmtValue(s.nominal)}` : undefined} />
        <Tile label="σ short-term" value={fmtValue(s.sigmaWithin, 5)} sub={`overall ${fmtValue(s.sigmaOverall, 5)}`} />
        <Tile label="Cp" value={fmtIndex(s.capability.cp)} sub={s.lsl === null || s.usl === null ? "one-sided limit" : undefined} />
        <Tile label="Cpk" value={fmtIndex(s.capability.cpk)} emphasis />
        <Tile label="Pp" value={fmtIndex(s.capability.pp)} />
        <Tile label="Ppk" value={fmtIndex(s.capability.ppk)} emphasis />
        <Tile label="Capability" value="" extra={<GradePill grade={s.grade} reliable stable={s.stable} />} sub={s.stable ? "no control rule broken" : "the process changed — find the cause first"} />
        <Tile label="Out of tolerance" value={String(s.outOfSpec)} sub={`${s.signalPoints} point${s.signalPoints === 1 ? "" : "s"} with a signal`} />
      </div>

      {error && <p className="ui-message ui-message-error">{error}</p>}
      {series?.truncated && <p className="ui-message ui-message-info">Showing the latest 1,000 values of the period.</p>}
      {series?.limitsChanged && <p className="ui-message ui-message-info">Some values were measured against other limits (an earlier plan version). Capability uses the current limits.</p>}

      {series && (
        <>
          <h3 className="ui-section-title spc-chart-title">Individual values (I chart)</h3>
          <div className="spc-legend" aria-hidden="true">
            <span><i className="spc-key-line" /> measured value</span>
            <span><i className="spc-key-spec" /> out of tolerance</span>
            <span><i className="spc-key-signal" /> control rule broken</span>
            <span><i className="spc-key-ref spc-ref-spec" /> tolerance (LSL / USL)</span>
            <span><i className="spc-key-ref spc-ref-control" /> control limits (UCL / LCL)</span>
          </div>
          <ControlChart
            ariaLabel={`Individual values of ${s.name}`}
            points={pts.map((p, i) => ({ y: p.value, flag: !p.passed ? "spec" : p.signals.length ? "signal" : null, tooltip: tip(i, "value") }))}
            refs={refsI}
            xLabels={dateLabel}
            showMarkers={pts.length <= 200}
          />
          <h3 className="ui-section-title spc-chart-title">Moving range (MR chart)</h3>
          <ControlChart
            ariaLabel={`Moving range of ${s.name}`}
            height={150}
            points={pts.map((p, i) => ({ y: p.mr, flag: st?.mrUcl != null && p.mr !== null && p.mr > st.mrUcl ? "signal" : null, tooltip: tip(i, "mr") }))}
            refs={refsMr}
            xLabels={dateLabel}
            showMarkers={pts.length <= 200}
          />
          <div className="spc-row">
            <div>
              <h3 className="ui-section-title spc-chart-title">Distribution</h3>
              <Histogram
                ariaLabel={`Distribution of ${s.name}`}
                values={pts.map((p) => p.value)}
                unit={s.unit}
                refs={[
                  ...(s.lsl !== null ? [{ y: s.lsl, label: "LSL", tone: "spec" as const }] : []),
                  ...(s.usl !== null ? [{ y: s.usl, label: "USL", tone: "spec" as const }] : []),
                  ...(st ? [{ y: st.mean, label: "x̄", tone: "center" as const }] : []),
                ]}
              />
            </div>
            <div className="spc-reading">
              <h3 className="ui-section-title spc-chart-title">Reading it</h3>
              <ul>
                <li>
                  <strong>Points beyond UCL / LCL</strong> or a run / trend (◆) mean something changed in the process (tool wear, material, setting): find the cause before
                  parts go out of tolerance.
                </li>
                <li>
                  <strong>Cp high but Cpk low</strong>: the spread is fine, the process is off-centre — adjust towards the nominal.
                </li>
                <li>
                  <strong>Cpk much higher than Ppk</strong>: the process drifts between checks — look at shifts, setups, material lots.
                </li>
              </ul>
            </div>
          </div>
          {showTable && (
            <div className="ui-table-wrap" style={{ marginTop: 12 }}>
              <table className="ui-table" aria-label={`Values of ${s.name}`}>
                <thead>
                  <tr>
                    <th>Measured</th>
                    <th style={{ textAlign: "right" }}>Value</th>
                    <th style={{ textAlign: "right" }}>MR</th>
                    <th>Check</th>
                    <th>Work order</th>
                    <th>Machine / by</th>
                    <th>Signals</th>
                  </tr>
                </thead>
                <tbody>
                  {[...pts].reverse().map((p) => (
                    <tr key={p.id} onClick={() => setOpenCheck(p.checkId)} style={{ cursor: "pointer" }}>
                      <td>{formatDateTime(p.at)}</td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {fmtValue(p.value)} {!p.passed && <span className="ui-pill ui-pill-alarm">Out</span>}
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {fmtValue(p.mr)}
                      </td>
                      <td>
                        {KIND_LABEL[p.kind]}
                        {p.attempt > 1 ? <span className="ui-sub">attempt {p.attempt}</span> : null}
                      </td>
                      <td>{p.orderNumber}</td>
                      <td>
                        {p.machineName ?? "—"}
                        <span className="ui-sub">{p.measuredByName ?? "—"}</span>
                      </td>
                      <td>{p.signals.length ? p.signals.map((r) => SIGNAL_LABEL[r]).join("; ") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {!series && !error && <p className="ui-field-hint">Loading…</p>}
      {openCheck && <CheckDrawer id={openCheck} onClose={() => setOpenCheck(null)} />}
    </section>
  );
}

function Tile({ label, value, sub, extra, emphasis }: { label: string; value: string; sub?: string; extra?: React.ReactNode; emphasis?: boolean }) {
  return (
    <div className="spc-tile" data-emphasis={emphasis ? "true" : undefined}>
      <span className="spc-tile-label">{label}</span>
      {value !== "" && <span className="spc-tile-value num">{value}</span>}
      {extra}
      {sub && <span className="ui-sub">{sub}</span>}
    </div>
  );
}
