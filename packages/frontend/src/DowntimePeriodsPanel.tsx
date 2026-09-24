import { useEffect, useState } from "react";
import { useAuth } from "./auth-context.js";

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

const WS_URL = import.meta.env.VITE_BACKEND_WS_URL ?? "ws://localhost:3001/ws";
const API_BASE = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");

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

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function DowntimePeriodsPanel() {
  const { auth, logout } = useAuth();
  const [periods, setPeriods] = useState<DowntimePeriod[]>([]);
  const [faultCodes, setFaultCodes] = useState<FaultCode[]>([]);
  const [error, setError] = useState<string | null>(null);

  function load() {
    Promise.all([
      fetch(`${API_BASE}/api/downtime-periods/unexplained`, { headers: { Authorization: `Bearer ${auth?.token}` } }).then((res) => {
        if (res.status === 401) {
          logout();
          throw new Error("session expired — please sign in again");
        }
        return res.json();
      }),
      fetch(`${API_BASE}/api/fault-codes`).then((r) => r.json()),
    ])
      .then(([p, fc]) => {
        setPeriods(p);
        setFaultCodes(fc);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }

  useEffect(load, []);

  async function explain(periodId: string, faultCodeId: string) {
    const res = await fetch(`${API_BASE}/api/downtime-periods/${encodeURIComponent(periodId)}/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
      body: JSON.stringify({ faultCodeId }),
    });
    if (res.status === 401) {
      logout();
      return;
    }
    load();
  }

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Unexplained downtime</h2>
      <p style={{ fontSize: 12, color: "#898781" }}>
        Automatically detected stop periods that don't have a reason attached yet.
      </p>

      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}
      {periods.length === 0 && <p style={{ color: "#898781" }}>No unexplained downtime.</p>}

      {periods.map((p) => {
        const codes = faultCodes.filter((fc) => fc.machineId === p.machineId && fc.isActive);
        return (
          <div key={p.id} style={{ border: "1px solid #eda100", borderRadius: 10, padding: 12, marginTop: 8 }}>
            <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
              <div style={{ fontWeight: 600 }}>{p.machineName}</div>
              <div style={{ fontSize: 12, color: "#898781" }}>
                {new Date(p.startedAt).toLocaleString()} — {formatDuration(p.durationSeconds)}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              {codes.map((fc) => (
                <button key={fc.id} style={secondaryButtonStyle} onClick={() => explain(p.id, fc.id)}>
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