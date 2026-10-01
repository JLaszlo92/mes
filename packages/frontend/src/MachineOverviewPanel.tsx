import { useEffect, useMemo, useState } from "react";
import { apiFetch, API_BASE } from "./api.js";
import { useScope } from "./scope.js";
import { navigate } from "./router.js";
import type { Machine } from "./master-data.js";

interface CurrentShift {
  machineId: string;
  shiftName: string;
  goodCount: number;
  scrapCount: number;
  availability: number;
  performance: number | null;
  quality: number | null;
  oee: number | null;
}

interface LiveState {
  status: string;
  lastUpdated: string;
}

interface AlertRow {
  machineId: string | null;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
}

/**
 * ISA-101 elv: a szín a rendellenességé. "down" → riasztás; nincs élő adat →
 * figyelmeztetés; minden más semleges (a futó gép NEM zöld). Műszakon kívül
 * halványítva.
 */
type TileState = "alarm" | "warning" | "normal" | "inactive";

const STATUS_LABEL: Record<string, string> = {
  running: "Running",
  idle: "Idle",
  down: "Down",
  changeover: "Changeover",
  off_shift: "Off shift",
};

function tileState(live: LiveState | undefined): TileState {
  if (!live) return "warning";
  if (live.status === "down") return "alarm";
  if (live.status === "off_shift") return "inactive";
  return "normal";
}

const STATE_RANK: Record<TileState, number> = { alarm: 0, warning: 1, normal: 2, inactive: 3 };

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * Élő áttekintés: KPI-sor a hatókör egészére, alatta kompakt gépcsempék
 * soronként (vagy részlegenként) csoportosítva. A leállt gépek kerülnek előre.
 */
export default function MachineOverviewPanel({ liveState }: { liveState: Record<string, LiveState> }) {
  const { machines: allMachines, hierarchy, isInScope, scope } = useScope();
  const [shiftByMachine, setShiftByMachine] = useState<Record<string, CurrentShift>>({});
  const [alerts, setAlerts] = useState<AlertRow[]>([]);

  const machines = useMemo(() => allMachines.filter((m) => m.isActive && isInScope(m.id)), [allMachines, isInScope]);

  useEffect(() => {
    let cancelled = false;
    const loadShifts = () =>
      apiFetch(`${API_BASE}/api/machines/current-shift`)
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: CurrentShift[]) => {
          if (!cancelled) setShiftByMachine(Object.fromEntries(rows.map((r) => [r.machineId, r])));
        })
        .catch(() => {});
    const loadAlerts = () =>
      apiFetch(`${API_BASE}/api/alerts`)
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: AlertRow[]) => {
          if (!cancelled) setAlerts(rows);
        })
        .catch(() => {});
    void loadShifts();
    void loadAlerts();
    const t1 = setInterval(loadShifts, 10_000);
    const t2 = setInterval(loadAlerts, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t1);
      clearInterval(t2);
    };
  }, []);

  const kpis = useMemo(() => {
    let running = 0;
    let down = 0;
    let noData = 0;
    let good = 0;
    let scrap = 0;
    const oees: number[] = [];
    for (const m of machines) {
      const live = liveState[m.id];
      if (!live) noData++;
      else if (live.status === "running") running++;
      else if (live.status === "down") down++;
      const s = shiftByMachine[m.id];
      if (s) {
        good += s.goodCount;
        scrap += s.scrapCount;
        if (s.oee !== null) oees.push(s.oee);
      }
    }
    const scoped = alerts.filter((a) => !a.resolvedAt && isInScope(a.machineId));
    return {
      running,
      down,
      noData,
      good,
      scrap,
      scrapRate: good + scrap > 0 ? scrap / (good + scrap) : null,
      oee: oees.length > 0 ? oees.reduce((a, b) => a + b, 0) / oees.length : null,
      openAlerts: scoped.length,
      unacknowledged: scoped.filter((a) => !a.acknowledgedAt).length,
    };
  }, [machines, liveState, shiftByMachine, alerts, isInScope]);

  // Csoportosítás soronként; sor nélküli gépek a részlegük alatt.
  const groups = useMemo(() => {
    const areaName = new Map(hierarchy.areas.map((a) => [a.id, a.name]));
    const lineName = new Map(hierarchy.lines.map((l) => [l.id, l.name]));
    const map = new Map<string, { key: string; title: string; machines: Machine[] }>();
    for (const m of machines) {
      const key = m.lineId ?? `area:${m.areaId}`;
      const area = areaName.get(m.areaId) ?? "";
      const title = m.lineId ? `${scope.areaId ? "" : `${area} / `}${lineName.get(m.lineId) ?? ""}` : `${area}, no line`;
      if (!map.has(key)) map.set(key, { key, title, machines: [] });
      map.get(key)!.machines.push(m);
    }
    const list = [...map.values()];
    for (const g of list) {
      g.machines.sort((a, b) => STATE_RANK[tileState(liveState[a.id])] - STATE_RANK[tileState(liveState[b.id])] || a.name.localeCompare(b.name));
    }
    return list.sort((a, b) => a.title.localeCompare(b.title));
  }, [machines, hierarchy, liveState, scope.areaId]);

  const shiftName = Object.values(shiftByMachine)[0]?.shiftName;

  if (allMachines.length === 0) return <p className="ui-message ui-message-info">No machines registered yet.</p>;

  return (
    <section className="ui-panel" style={{ marginTop: 8 }}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Live status</h2>
        {shiftName && <span className="ui-panel-count" style={{ textTransform: "capitalize" }}>{shiftName} shift</span>}
      </div>

      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Running</span>
          <span className="kpi-value num">
            {kpis.running}
            <span className="kpi-of"> / {machines.length}</span>
          </span>
        </div>
        <div className="kpi" data-state={kpis.down > 0 ? "alarm" : undefined}>
          <span className="kpi-label">Down</span>
          <span className="kpi-value num">{kpis.down}</span>
          {kpis.noData > 0 && <span className="kpi-note">{kpis.noData} without live data</span>}
        </div>
        <div className="kpi">
          <span className="kpi-label">OEE this shift</span>
          <span className="kpi-value num">{pct(kpis.oee)}</span>
          <span className="kpi-note">Average across machines</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Good parts</span>
          <span className="kpi-value num">{kpis.good.toLocaleString()}</span>
          <span className="kpi-note num">
            {kpis.scrap.toLocaleString()} scrap{kpis.scrapRate !== null ? ` (${(kpis.scrapRate * 100).toFixed(1)}%)` : ""}
          </span>
        </div>
        <button
          type="button"
          className="kpi kpi-link"
          data-state={kpis.unacknowledged > 0 ? "alarm" : undefined}
          onClick={() => navigate("/alerts/all")}
        >
          <span className="kpi-label">Open alerts</span>
          <span className="kpi-value num">{kpis.openAlerts}</span>
          <span className="kpi-note">{kpis.unacknowledged > 0 ? `${kpis.unacknowledged} not acknowledged` : "All acknowledged"}</span>
        </button>
      </div>

      {machines.length === 0 && <p className="ui-message ui-message-info">No active machines in the selected site, area or line.</p>}

      {groups.map((g) => (
        <div key={g.key} className="tile-group">
          {groups.length > 1 && <h3 className="tile-group-title">{g.title}</h3>}
          <div className="tiles">
            {g.machines.map((m) => {
              const live = liveState[m.id];
              const shift = shiftByMachine[m.id];
              const state = tileState(live);
              return (
                <article key={m.id} className="tile" data-state={state} aria-label={`${m.name}: ${live ? STATUS_LABEL[live.status] ?? live.status : "no live data"}`}>
                  <header className="tile-head">
                    <span className="tile-name">{m.name}</span>
                    <span className="tile-status">{live ? STATUS_LABEL[live.status] ?? live.status : "No live data"}</span>
                  </header>
                  <div className="tile-body">
                    <div>
                      <span className="tile-oee num">{pct(shift?.oee)}</span>
                      <span className="tile-caption">OEE</span>
                    </div>
                    <div className="tile-counts num">
                      <span>{shift ? shift.goodCount.toLocaleString() : "—"} good</span>
                      <span>{shift ? shift.scrapCount.toLocaleString() : "—"} scrap</span>
                    </div>
                  </div>
                  <footer className="tile-foot num">
                    <span title="Availability">A {pct(shift?.availability)}</span>
                    <span title="Performance">P {pct(shift?.performance)}</span>
                    <span title="Quality">Q {pct(shift?.quality)}</span>
                    <span className="tile-time">{live ? timeFmt.format(new Date(live.lastUpdated)) : ""}</span>
                  </footer>
                </article>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
