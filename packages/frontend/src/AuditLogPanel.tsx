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

const ACTION_COLOR: Record<string, string> = {
  login_success: "#0ca30c",
  login_failed: "#d03b3b",
  logout: "#898781",
  machine_created: "#0ca30c",
  machine_updated: "#eda100",
};

export default function AuditLogPanel() {
  const { auth } = useAuth();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (auth?.role !== "admin") return;
    fetch(`${API_BASE}/api/audit-log`, { headers: { Authorization: `Bearer ${auth.token}` } })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then(setEntries)
      .catch((err) => setError(String(err)));
  }, [auth]);

  // Csak admin lássa — ez a legérzékenyebb nézet a rendszerben.
  if (auth?.role !== "admin") return null;

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Audit log</h2>
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
    </section>
  );
}