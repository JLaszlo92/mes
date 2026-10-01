import { useEffect, useState } from "react";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE } from "./api.js";
import { useScope } from "./scope.js";

interface DowntimePeriod {
  id: string;
  machineId: string;
  machineName: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
}

interface FaultCode {
  id: string;
  machineId: string;
  code: string;
  name: string;
  isActive: boolean;
}

interface DowntimeSummary {
  machineId: string;
  machineName: string;
  microStopThresholdSeconds: number;
  stops: number;
  stopSeconds: number;
  microStops: number;
  microStopSeconds: number;
  unexplained: number;
}

const SUMMARY_HOURS = 24;

const secondaryButtonStyle = {
  padding: "8px 14px",
  border: "1px solid #0b0b0b",
  borderRadius: 8,
  background: "#fff",
  color: "#0b0b0b",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
};
const cell = { padding: "6px 10px", fontSize: 13, borderBottom: "1px solid #f0efeb", textAlign: "right" as const };
const headCell = { ...cell, fontSize: 11, color: "#898781", fontWeight: 600, borderBottom: "1px solid #e1e0d9" };

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `${fallback} (${res.status})`;
}

/** A küszöb szerkesztője egy sorban: helyi szövegállapot, mentés Enterre vagy fókuszvesztésre. */
function ThresholdInput({ summary, onSave }: { summary: DowntimeSummary; onSave: (seconds: number) => Promise<void> }) {
  const [value, setValue] = useState(String(summary.microStopThresholdSeconds));
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(String(summary.microStopThresholdSeconds)), [summary.microStopThresholdSeconds]);

  async function commit() {
    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds === summary.microStopThresholdSeconds) {
      setValue(String(summary.microStopThresholdSeconds));
      return;
    }
    setSaving(true);
    try {
      await onSave(seconds);
    } finally {
      setSaving(false);
    }
  }

  return (
    <input
      type="number"
      min={0}
      max={3600}
      step={1}
      value={value}
      disabled={saving}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      style={{ width: 64, padding: 4, border: "1px solid #e1e0d9", borderRadius: 6, textAlign: "right" }}
      title="Micro-stop threshold in seconds — shorter stops are summarized, not listed for explanation"
    />
  );
}

export default function DowntimePeriodsPanel() {
  const { isInScope } = useScope();
  const { auth } = useAuth();
  const [periods, setPeriods] = useState<DowntimePeriod[]>([]);
  const [faultCodes, setFaultCodes] = useState<FaultCode[]>([]);
  const [summary, setSummary] = useState<DowntimeSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** A mentés alatt álló periódus — addig a gombjai zárolva vannak (dupla kattintás ellen). */
  const [explainingId, setExplainingId] = useState<string | null>(null);

  const canEditThreshold = auth?.role === "admin" || auth?.role === "manager";

  // A token hozzáadását és a 401-es kiléptetést az apiFetch végzi.
  async function load() {
    try {
      const getJson = <T,>(path: string) =>
        apiFetch(`${API_BASE}${path}`).then((r) =>
          r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(`${path}: ${r.status}`)),
        );
      const [p, fc, s] = await Promise.all([
        getJson<DowntimePeriod[]>("/api/downtime-periods/unexplained"),
        getJson<FaultCode[]>("/api/fault-codes"),
        getJson<DowntimeSummary[]>(`/api/downtime-periods/summary?hours=${SUMMARY_HOURS}`),
      ]);
      setPeriods(p);
      setFaultCodes(fc);
      setSummary(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function explain(periodId: string, faultCodeId: string) {
    if (explainingId) return;
    setExplainingId(periodId);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/downtime-periods/${encodeURIComponent(periodId)}/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ faultCodeId }),
      });
      if (!res.ok) setError(await errorMessage(res, "Failed to record the reason"));
      await load();
    } finally {
      setExplainingId(null);
    }
  }

  async function saveThreshold(machineId: string, seconds: number) {
    setError(null);
    const res = await apiFetch(`${API_BASE}/api/machine-registry/${encodeURIComponent(machineId)}/micro-stop-threshold`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seconds }),
    });
    if (!res.ok) setError(await errorMessage(res, "Failed to save threshold"));
    await load();
  }

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Downtime — last {SUMMARY_HOURS} hours</h2>
      <p style={{ fontSize: 12, color: "#898781" }}>
        Stops shorter than a machine's micro-stop threshold are counted here but don't need a reason.
        Longer stops are listed below for explanation.
      </p>

      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}

      {summary.length > 0 && (
        <div style={{ overflowX: "auto", border: "1px solid #e1e0d9", borderRadius: 10 }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ ...headCell, textAlign: "left" }}>Machine</th>
                <th style={headCell}>Stops</th>
                <th style={headCell}>Stop time</th>
                <th style={headCell}>Micro-stops</th>
                <th style={headCell}>Micro-stop time</th>
                <th style={headCell}>To explain</th>
                <th style={headCell}>Threshold (s)</th>
              </tr>
            </thead>
            <tbody>
              {summary.filter((s) => isInScope(s.machineId)).map((s) => (
                <tr key={s.machineId}>
                  <td style={{ ...cell, textAlign: "left", fontWeight: 600 }}>{s.machineName}</td>
                  <td style={cell}>{s.stops}</td>
                  <td style={cell}>{formatDuration(s.stopSeconds)}</td>
                  <td style={cell}>{s.microStops}</td>
                  <td style={cell}>{formatDuration(s.microStopSeconds)}</td>
                  <td style={{ ...cell, color: s.unexplained > 0 ? "#b36b00" : undefined, fontWeight: s.unexplained > 0 ? 600 : 400 }}>
                    {s.unexplained}
                  </td>
                  <td style={cell}>
                    {canEditThreshold ? (
                      <ThresholdInput summary={s} onSave={(seconds) => saveThreshold(s.machineId, seconds)} />
                    ) : (
                      s.microStopThresholdSeconds
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 style={{ fontSize: 14, marginTop: 24 }}>Unexplained downtime</h3>
      {periods.length === 0 && <p style={{ color: "#898781" }}>No unexplained downtime.</p>}

      {periods.filter((p) => isInScope(p.machineId)).map((p) => {
        const codes = faultCodes.filter((fc) => fc.machineId === p.machineId && fc.isActive);
        const busy = explainingId !== null;
        return (
          <div key={p.id} style={{ border: "1px solid #eda100", borderRadius: 10, padding: 12, marginTop: 8, opacity: explainingId === p.id ? 0.6 : 1 }}>
            <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
              <div style={{ fontWeight: 600 }}>{p.machineName}</div>
              <div style={{ fontSize: 12, color: "#898781" }}>
                {new Date(p.startedAt).toLocaleString()} — {formatDuration(p.durationSeconds)}
              </div>
              {explainingId === p.id && <span style={{ fontSize: 12, color: "#898781" }}>Saving…</span>}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              {codes.map((fc) => (
                <button
                  key={fc.id}
                  style={{ ...secondaryButtonStyle, cursor: busy ? "progress" : "pointer" }}
                  disabled={busy}
                  onClick={() => void explain(p.id, fc.id)}
                >
                  {fc.code} — {fc.name}
                </button>
              ))}
              {codes.length === 0 && (
                <span style={{ fontSize: 12, color: "#898781" }}>No fault codes configured for this machine.</span>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
