import { useEffect, useState } from "react";
import { apiFetch, API_BASE } from "./api.js";

type ParetoKind = "code" | "unexplained" | "micro";

interface ParetoItem {
  kind: ParetoKind;
  code: string | null;
  name: string | null;
  periods: number;
  seconds: number;
}

interface DowntimePareto {
  hours: number;
  machineId: string | null;
  totalSeconds: number;
  explainedSeconds: number;
  explainableSeconds: number;
  items: ParetoItem[];
}

interface Machine {
  id: string;
  name: string;
  isActive: boolean;
}

const RANGES = [
  { hours: 24, label: "Last 24 hours" },
  { hours: 168, label: "Last 7 days" },
  { hours: 720, label: "Last 30 days" },
];

/** Ennyi lefedettség alatt figyelmeztet, hogy az ábra hiányos. */
const COVERAGE_WARNING = 0.8;

const COLORS: Record<ParetoKind, string> = {
  code: "#185fa5",
  unexplained: "#e8a33d",
  micro: "#a8a69f",
};

const selectStyle = { padding: 6, border: "1px solid #e1e0d9", borderRadius: 6, fontSize: 13 };

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function label(item: ParetoItem): string {
  if (item.kind === "unexplained") return "Unexplained";
  if (item.kind === "micro") return "Micro-stops";
  return `${item.code} — ${item.name}`;
}

/**
 * Leállási idő okonként, csökkenő sorrendben, halmozott százalékkal. A
 * "Unexplained" és a "Micro-stops" sáv külön színű; ha a küszöb feletti
 * leállási idő nagy része nincs megmagyarázva, a panel figyelmeztet, hogy
 * az ábra nem ad megbízható képet az okokról.
 */
export default function DowntimeParetoPanel() {
  const [hours, setHours] = useState(168);
  const [machineId, setMachineId] = useState("");
  const [machines, setMachines] = useState<Machine[]>([]);
  const [pareto, setPareto] = useState<DowntimePareto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch(`${API_BASE}/api/machine-registry?active=true`)
      .then((r) => (r.ok ? (r.json() as Promise<Machine[]>) : Promise.reject(new Error(`machines: ${r.status}`))))
      .then((m) => setMachines(m.filter((x) => x.isActive)))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams({ hours: String(hours) });
    if (machineId) params.set("machineId", machineId);
    apiFetch(`${API_BASE}/api/downtime-periods/pareto?${params}`)
      .then((r) => (r.ok ? (r.json() as Promise<DowntimePareto>) : Promise.reject(new Error(`pareto: ${r.status}`))))
      .then((p) => {
        setPareto(p);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [hours, machineId]);

  const maxSeconds = Math.max(1, ...(pareto?.items.map((i) => i.seconds) ?? [1]));
  const coverage = pareto && pareto.explainableSeconds > 0 ? pareto.explainedSeconds / pareto.explainableSeconds : null;
  let cumulative = 0;

  return (
    <section style={{ marginTop: 32 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Downtime by reason</h2>
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))} style={selectStyle}>
          {RANGES.map((r) => (
            <option key={r.hours} value={r.hours}>{r.label}</option>
          ))}
        </select>
        <select value={machineId} onChange={(e) => setMachineId(e.target.value)} style={selectStyle}>
          <option value="">All machines</option>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
        {pareto && (
          <span style={{ fontSize: 12, color: "#898781" }}>Total downtime {formatDuration(pareto.totalSeconds)}</span>
        )}
      </div>

      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}

      {coverage !== null && coverage < COVERAGE_WARNING && (
        <p style={{ fontSize: 12, color: "#8a5a00", background: "#fdf6e8", border: "1px solid #f0d9a8", borderRadius: 8, padding: "8px 10px" }}>
          Only {Math.round(coverage * 100)}% of the downtime above the micro-stop threshold has a reason. The ranking
          below may not reflect the real causes — explain the open stops in the list below first.
        </p>
      )}

      {pareto && pareto.items.length === 0 && <p style={{ color: "#898781", fontSize: 13 }}>No downtime in this period.</p>}

      {pareto && pareto.items.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {pareto.items.map((item) => {
            cumulative += item.seconds;
            const share = pareto.totalSeconds > 0 ? item.seconds / pareto.totalSeconds : 0;
            const cumShare = pareto.totalSeconds > 0 ? cumulative / pareto.totalSeconds : 0;
            return (
              <div
                key={`${item.kind}:${item.code ?? ""}:${item.name ?? ""}`}
                style={{ display: "grid", gridTemplateColumns: "minmax(140px, 220px) 1fr 150px", gap: 10, alignItems: "center", padding: "4px 0" }}
              >
                <div style={{ fontSize: 13, fontWeight: item.kind === "code" ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={label(item)}>
                  {label(item)}
                </div>
                <div style={{ background: "#f6f5f1", borderRadius: 4, height: 18, minWidth: 0 }}>
                  <div
                    style={{
                      width: `${(item.seconds / maxSeconds) * 100}%`,
                      minWidth: 2,
                      height: "100%",
                      background: COLORS[item.kind],
                      borderRadius: 4,
                    }}
                  />
                </div>
                <div style={{ fontSize: 12, color: "#5f5e5a", textAlign: "right", whiteSpace: "nowrap" }}>
                  {formatDuration(item.seconds)} · {Math.round(share * 100)}%
                  <span style={{ color: "#898781" }}> · Σ {Math.round(cumShare * 100)}%</span>
                  <div style={{ fontSize: 11, color: "#a8a69f" }}>
                    {item.periods} stop{item.periods === 1 ? "" : "s"}
                  </div>
                </div>
              </div>
            );
          })}
          <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 11, color: "#898781" }}>
            <span><span style={{ color: COLORS.code }}>■</span> reason given</span>
            <span><span style={{ color: COLORS.unexplained }}>■</span> no (accepted) reason yet</span>
            <span><span style={{ color: COLORS.micro }}>■</span> stops below the micro-stop threshold</span>
          </div>
        </div>
      )}
    </section>
  );
}
