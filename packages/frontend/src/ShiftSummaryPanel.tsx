import { useEffect, useState } from "react";

interface ShiftSummary {
  shiftDate: string;
  shiftName: string;
  machineId: string;
  goodCount: number;
  scrapCount: number;
  statusSeconds: Record<string, number>;
  runningSeconds: number;
  totalSeconds: number;
  productionRatio: number;
  availability: number;
  performance: number | null;
  quality: number | null;
  oee: number | null;
}

const BUILTIN_COLOR: Record<string, string> = { running: "#0ca30c", down: "#d03b3b" };
const FALLBACK_PALETTE = ["#eda100", "#185fa5", "#898781", "#7c4dff", "#00897b"];

function colorForStatus(status: string, fallbackIndex: number): string {
  return BUILTIN_COLOR[status] ?? FALLBACK_PALETTE[fallbackIndex % FALLBACK_PALETTE.length];
}

const SHIFT_ORDER = ["day", "afternoon", "night"];

const WS_URL = import.meta.env.VITE_BACKEND_WS_URL ?? "ws://localhost:3001/ws";
const API_BASE = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function latestPerShift(rows: ShiftSummary[]): ShiftSummary[] {
  const latest = new Map<string, ShiftSummary>();
  for (const row of rows) {
    const key = `${row.shiftName}|${row.machineId}`;
    const existing = latest.get(key);
    if (!existing || row.shiftDate > existing.shiftDate) {
      latest.set(key, row);
    }
  }
  return [...latest.values()].sort(
    (a, b) =>
      SHIFT_ORDER.indexOf(a.shiftName) - SHIFT_ORDER.indexOf(b.shiftName) ||
      a.machineId.localeCompare(b.machineId),
  );
}

export default function ShiftSummaryPanel() {
  const [rows, setRows] = useState<ShiftSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const to = new Date();
    const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
    const url = `${API_BASE}/api/shifts/summary?from=${from.toISOString()}&to=${to.toISOString()}`;

    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json() as Promise<ShiftSummary[]>;
      })
      .then(setRows)
      .catch((err) => setError(String(err)));
  }, []);

  if (error) {
    return <p style={{ color: "#d03b3b", fontSize: 13 }}>Failed to load shift summary: {error}</p>;
  }
  if (!rows) {
    return <p style={{ color: "#898781" }}>Loading shift summary…</p>;
  }

  const shifts = latestPerShift(rows);

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Shift summary</h2>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {shifts.map((s) => {
          const statusEntries = Object.entries(s.statusSeconds).sort((a, b) => {
            if (a[0] === "running") return -1;
            if (b[0] === "running") return 1;
            return b[1] - a[1];
          });

          return (
            <div
              key={`${s.shiftName}-${s.machineId}`}
              style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 16, minWidth: 220, flex: "1 1 220px" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontWeight: 600, textTransform: "capitalize" }}>{s.shiftName}</div>
                <div style={{ fontSize: 12, color: "#898781" }}>{s.shiftDate}</div>
              </div>
              <div style={{ fontSize: 12, color: "#898781", marginTop: 2 }}>{s.machineId}</div>

              <div style={{ display: "flex", gap: 20, marginTop: 12 }}>
                <div>
                  <div style={{ fontSize: 12, color: "#898781" }}>Good</div>
                  <div style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{s.goodCount}</div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: "#898781" }}>Scrap</div>
                  <div style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{s.scrapCount}</div>
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", background: "#e1e0d9" }}>
                  {statusEntries.map(([status, seconds], i) => {
                    const pct = s.totalSeconds > 0 ? (seconds / s.totalSeconds) * 100 : 0;
                    if (pct <= 0) return null;
                    return (
                      <div
                        key={status}
                        title={`${status}: ${Math.round(pct)}% (${formatDuration(seconds)})`}
                        style={{ width: `${pct}%`, background: colorForStatus(status, i) }}
                      />
                    );
                  })}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#898781", marginTop: 4 }}>
                  <span>{Math.round(s.availability * 100)}% gyártás</span>
                  <span>{formatDuration(s.totalSeconds)}</span>
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, marginTop: 6, color: s.oee !== null ? "#0b0b0b" : "#898781" }}>
                  OEE: {s.oee !== null ? `${Math.round(s.oee * 100)}%` : "— (nincs ideális ciklusidő beállítva)"}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}