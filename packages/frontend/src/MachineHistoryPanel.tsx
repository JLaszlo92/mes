import { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart, Bar } from "recharts";
import { useAuth } from "./auth-context.js";

interface Machine {
  id: string;
  name: string;
}

interface HistoryBucket {
  bucketStart: string;
  goodCount: number;
  scrapCount: number;
  availability: number;
  oee: number | null;
  avgCycleTimeSeconds: number | null;
}

interface StatusSegment {
  status: string;
  startedAt: string;
  endedAt: string;
}

interface StatusDefinition {
  machineId: string | null;
  code: string;
  color: string | null;
}

const WS_URL = import.meta.env.VITE_BACKEND_WS_URL ?? "ws://localhost:3001/ws";
const API_BASE = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");

const inputStyle = { padding: 6, border: "1px solid #e1e0d9", borderRadius: 6 };

type RangePreset = "24h" | "7d" | "30d" | "90d";

const RANGE_CONFIG: Record<RangePreset, { hours: number; bucket: "hour" | "day" | "week" | "month" }> = {
  "24h": { hours: 24, bucket: "hour" },
  "7d": { hours: 24 * 7, bucket: "day" },
  "30d": { hours: 24 * 30, bucket: "day" },
  "90d": { hours: 24 * 90, bucket: "week" },
};

function formatBucketLabel(iso: string, bucket: string): string {
  const d = new Date(iso);
  if (bucket === "hour") return d.toLocaleTimeString([], { hour: "2-digit" });
  if (bucket === "week") return `Wk ${d.toLocaleDateString()}`;
  if (bucket === "month") return d.toLocaleDateString([], { month: "short", year: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function MachineHistoryPanel() {
  const { auth, logout } = useAuth();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [machineId, setMachineId] = useState("");
  const [range, setRange] = useState<RangePreset>("7d");
  const [buckets, setBuckets] = useState<HistoryBucket[]>([]);
  const [segments, setSegments] = useState<StatusSegment[]>([]);
  const [statusDefs, setStatusDefs] = useState<StatusDefinition[]>([]);
  const [rangeStart, setRangeStart] = useState<Date | null>(null);
  const [rangeEnd, setRangeEnd] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/machine-registry`)
      .then((r) => r.json())
      .then((data: Machine[]) => {
        setMachines(data);
        setMachineId((prev) => prev || data[0]?.id || "");
      });
    fetch(`${API_BASE}/api/status-definitions`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setStatusDefs)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!machineId || !auth) return;
    const { hours, bucket } = RANGE_CONFIG[range];
    const to = new Date();
    const from = new Date(to.getTime() - hours * 60 * 60 * 1000);
    setRangeStart(from);
    setRangeEnd(to);

    fetch(
      `${API_BASE}/api/machines/${encodeURIComponent(machineId)}/history?from=${from.toISOString()}&to=${to.toISOString()}&bucket=${bucket}`,
      { headers: { Authorization: `Bearer ${auth.token}` } },
    )
      .then((res) => {
        if (res.status === 401) {
          logout();
          throw new Error("session expired — please sign in again");
        }
        return res.json();
      })
      .then((data: HistoryBucket[]) => {
        setBuckets(data);
        setError(null);
      })
      .catch((err) => setError(String(err)));

    fetch(
      `${API_BASE}/api/machines/${encodeURIComponent(machineId)}/status-timeline?from=${from.toISOString()}&to=${to.toISOString()}`,
      { headers: { Authorization: `Bearer ${auth.token}` } },
    )
      .then((res) => (res.ok ? res.json() : []))
      .then(setSegments)
      .catch(() => setSegments([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId, range]);

  function colorForStatus(status: string): string {
    if (status === "running") return "#0ca30c";
    if (status === "down") return "#d03b3b";
    const machineSpecific = statusDefs.find((d) => d.machineId === machineId && d.code === status);
    if (machineSpecific?.color) return machineSpecific.color;
    const global = statusDefs.find((d) => d.machineId === null && d.code === status);
    if (global?.color) return global.color;
    return "#898781";
  }

  const bucket = RANGE_CONFIG[range].bucket;
  const chartData = buckets.map((b) => ({
    label: formatBucketLabel(b.bucketStart, bucket),
    good: b.goodCount,
    scrap: b.scrapCount,
    oee: b.oee !== null ? Math.round(b.oee * 100) : null,
    availability: Math.round(b.availability * 100),
    cycleTime: b.avgCycleTimeSeconds !== null ? Number(b.avgCycleTimeSeconds.toFixed(1)) : null,
  }));

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Machine history</h2>

      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <label style={{ fontSize: 12 }}>
          Machine<br />
          <select value={machineId} onChange={(e) => setMachineId(e.target.value)} style={inputStyle}>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>
          Period<br />
          <select value={range} onChange={(e) => setRange(e.target.value as RangePreset)} style={inputStyle}>
            <option value="24h">Last 24 hours (hourly)</option>
            <option value="7d">Last 7 days (daily)</option>
            <option value="30d">Last 30 days (daily)</option>
            <option value="90d">Last 90 days (weekly)</option>
          </select>
        </label>
      </div>

      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}

      {segments.length > 0 && rangeStart && rangeEnd && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 13, color: "#898781" }}>Status timeline</h3>
          <div style={{ display: "flex", height: 28, borderRadius: 6, overflow: "hidden", border: "1px solid #e1e0d9" }}>
            {segments.map((s, i) => {
              const totalMs = rangeEnd.getTime() - rangeStart.getTime();
              const durMs = new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime();
              const widthPct = totalMs > 0 ? (durMs / totalMs) * 100 : 0;
              if (widthPct <= 0) return null;
              return (
                <div
                  key={i}
                  title={`${s.status}: ${new Date(s.startedAt).toLocaleString()} → ${new Date(s.endedAt).toLocaleString()}`}
                  style={{ width: `${widthPct}%`, background: colorForStatus(s.status) }}
                />
              );
            })}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#898781", marginTop: 4 }}>
            <span>{rangeStart.toLocaleString()}</span>
            <span>{rangeEnd.toLocaleString()}</span>
          </div>
        </div>
      )}

      {buckets.length === 0 && !error && <p style={{ color: "#898781" }}>No data for this period.</p>}

      {buckets.length > 0 && (
        <>
          <div>
            <h3 style={{ fontSize: 13, color: "#898781" }}>Good / Scrap count</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" fontSize={11} />
                <YAxis fontSize={11} />
                <Tooltip />
                <Legend />
                <Bar dataKey="good" fill="#0ca30c" name="Good" />
                <Bar dataKey="scrap" fill="#d03b3b" name="Scrap" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div style={{ marginTop: 24 }}>
            <h3 style={{ fontSize: 13, color: "#898781" }}>OEE / Availability (%)</h3>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" fontSize={11} />
                <YAxis fontSize={11} domain={[0, 100]} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="oee" stroke="#185fa5" name="OEE" connectNulls />
                <Line type="monotone" dataKey="availability" stroke="#0ca30c" name="Availability" />
              </LineChart>
            </ResponsiveContainer>
          </div>
                    <div style={{ marginTop: 24 }}>
            <h3 style={{ fontSize: 13, color: "#898781" }}>Avg. cycle time (s)</h3>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" fontSize={11} />
                <YAxis fontSize={11} />
                <Tooltip />
                <Line type="monotone" dataKey="cycleTime" stroke="#eda100" name="Cycle time" connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </section>
  );
}