import { useEffect, useState } from "react";

interface Machine {
  id: string;
  name: string;
  isActive: boolean;
}

interface CurrentShift {
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

const WS_URL = import.meta.env.VITE_BACKEND_WS_URL ?? "ws://localhost:3001/ws";
const API_BASE = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");

const STATUS_COLOR: Record<string, string> = {
  running: "#0ca30c",
  idle: "#898781",
  down: "#d03b3b",
  changeover: "#eda100",
};
const DEFAULT_STATUS_COLOR = "#185fa5";

function pct(v: number | null): string {
  return v !== null ? `${Math.round(v * 100)}%` : "—";
}

export default function MachineOverviewPanel({ liveState }: { liveState: Record<string, LiveState> }) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [shiftByMachine, setShiftByMachine] = useState<Record<string, CurrentShift>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/machine-registry`)
      .then((r) => r.json())
      .then((data: Machine[]) => setMachines(data.filter((m) => m.isActive)))
      .catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    if (machines.length === 0) return;

    function loadShifts() {
      Promise.all(
        machines.map((m) =>
          fetch(`${API_BASE}/api/machines/${encodeURIComponent(m.id)}/current-shift`)
            .then((r) => (r.ok ? r.json() : null))
            .then((summary: CurrentShift | null) => [m.id, summary] as const),
        ),
      ).then((pairs) => {
        const next: Record<string, CurrentShift> = {};
        for (const [id, summary] of pairs) if (summary) next[id] = summary;
        setShiftByMachine(next);
      });
    }

    loadShifts();
    const timer = setInterval(loadShifts, 10000);
    return () => clearInterval(timer);
  }, [machines]);

  if (error) return <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>;
  if (machines.length === 0) return <p style={{ color: "#898781" }}>No machines registered yet.</p>;

  return (
    <section>
      <h2 style={{ fontSize: 16 }}>Machines — current shift</h2>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {machines.map((m) => {
          const live = liveState[m.id];
          const shift = shiftByMachine[m.id];
          return (
            <div key={m.id} style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 16, minWidth: 240, flex: "1 1 240px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontWeight: 600 }}>{m.name}</div>
                <div style={{ fontSize: 11, color: "#898781" }}>{m.id}</div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 13 }}>
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: live ? STATUS_COLOR[live.status] ?? DEFAULT_STATUS_COLOR : "#e1e0d9",
                    display: "inline-block",
                  }}
                />
                {live ? live.status : "no live data"}
                {live && <span style={{ color: "#898781", marginLeft: "auto" }}>{new Date(live.lastUpdated).toLocaleTimeString()}</span>}
              </div>

              {shift ? (
                <>
                  <div style={{ fontSize: 12, color: "#898781", marginTop: 10, textTransform: "capitalize" }}>{shift.shiftName} shift</div>
                  <div style={{ display: "flex", gap: 20, marginTop: 4 }}>
                    <div>
                      <div style={{ fontSize: 12, color: "#898781" }}>Good</div>
                      <div style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{shift.goodCount}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: "#898781" }}>Scrap</div>
                      <div style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{shift.scrapCount}</div>
                    </div>
                  </div>
                  <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
                    <div>Availability: <strong>{pct(shift.availability)}</strong></div>
                    <div>Performance: <strong>{pct(shift.performance)}</strong></div>
                    <div>Quality: <strong>{pct(shift.quality)}</strong></div>
                    <div style={{ marginTop: 4, fontSize: 13 }}>OEE: <strong>{pct(shift.oee)}</strong></div>
                  </div>
                </>
              ) : (
                <p style={{ color: "#898781", fontSize: 12, marginTop: 10 }}>No data yet this shift.</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}