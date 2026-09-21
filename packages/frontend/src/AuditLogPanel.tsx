import { useEffect, useState } from "react";
import { useAuth } from "./auth-context.js";

interface AuditEntry {
  id: string;
  occurredAt: string;
  actorEmail: string | null;
  action: string;
  target: string | null;
  ipAddress: string | null;
}

const WS_URL = import.meta.env.VITE_BACKEND_WS_URL ?? "ws://localhost:3001/ws";
const API_BASE = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");
const PAGE_SIZE = 50;

const ACTION_COLOR: Record<string, string> = {
  login_success: "#0ca30c",
  login_failed: "#d03b3b",
  logout: "#898781",
  machine_created: "#0ca30c",
  machine_updated: "#eda100",
};

type RangePreset = "24h" | "7d" | "30d" | "all";

const RANGE_LABELS: Record<RangePreset, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
};

function rangeStart(preset: RangePreset): string | undefined {
  if (preset === "all") return undefined;
  const hours = preset === "24h" ? 24 : preset === "7d" ? 24 * 7 : 24 * 30;
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

const secondaryButtonStyle = {
  padding: "5px 10px",
  border: "1px solid #e1e0d9",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 12,
};

export default function AuditLogPanel() {
  const { auth, logout } = useAuth();
  const [range, setRange] = useState<RangePreset>("24h");
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  function load(offset: number, replace: boolean) {
    if (auth?.role !== "admin") return;
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    const from = rangeStart(range);
    if (from) params.set("from", from);

    fetch(`${API_BASE}/api/audit-log?${params.toString()}`, { headers: { Authorization: `Bearer ${auth.token}` } })
      .then((res) => {
        if (res.status === 401) {
          logout();
          throw new Error("session expired — please sign in again");
        }
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((page: { entries: AuditEntry[]; total: number }) => {
        setEntries((prev) => (replace ? page.entries : [...prev, ...page.entries]));
        setTotal(page.total);
        setError(null);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoadingMore(false));
  }

  useEffect(() => {
    load(0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, auth]);

  if (auth?.role !== "admin") return null;

  function loadMore() {
    setLoadingMore(true);
    load(entries.length, false);
  }

  return (
    <section style={{ marginTop: 32 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Audit log</h2>
        <div style={{ display: "flex", gap: 6 }}>
          {(Object.keys(RANGE_LABELS) as RangePreset[]).map((preset) => (
            <button
              key={preset}
              onClick={() => setRange(preset)}
              style={{
                ...secondaryButtonStyle,
                background: range === preset ? "#0b0b0b" : "#fff",
                color: range === preset ? "#fff" : "#0b0b0b",
              }}
            >
              {RANGE_LABELS[preset]}
            </button>
          ))}
        </div>
      </div>

      <p style={{ fontSize: 12, color: "#898781", marginTop: 4 }}>
        {total} entries in this range
      </p>

      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#898781" }}>
            <th style={{ padding: "4px 8px" }}>Time</th>
            <th style={{ padding: "4px 8px" }}>Actor</th>
            <th style={{ padding: "4px 8px" }}>Action</th>
            <th style={{ padding: "4px 8px" }}>Target</th>
            <th style={{ padding: "4px 8px" }}>IP</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} style={{ borderTop: "1px solid #e1e0d9" }}>
              <td style={{ padding: "4px 8px" }}>{new Date(e.occurredAt).toLocaleString()}</td>
              <td style={{ padding: "4px 8px" }}>{e.actorEmail ?? "—"}</td>
              <td style={{ padding: "4px 8px", color: ACTION_COLOR[e.action] ?? "#0b0b0b" }}>{e.action}</td>
              <td style={{ padding: "4px 8px" }}>{e.target ?? "—"}</td>
              <td style={{ padding: "4px 8px" }}>{e.ipAddress ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {entries.length < total && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          style={{ ...secondaryButtonStyle, marginTop: 12, width: "100%", padding: "8px 0" }}
        >
          {loadingMore ? "Loading…" : `Load more (${entries.length} of ${total})`}
        </button>
      )}
    </section>
  );
}