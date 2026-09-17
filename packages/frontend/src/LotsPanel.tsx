import { useEffect, useState } from "react";
import { useAuth } from "./auth-context.js";

interface Lot {
  id: string;
  lotNumber: string;
  orderNumber: string;
  machineName: string | null;
  operatorEmail: string | null;
  startedAt: string | null;
  completedAt: string;
  goodCount: number;
  scrapCount: number;
}

const WS_URL = import.meta.env.VITE_BACKEND_WS_URL ?? "ws://localhost:3001/ws";
const API_BASE = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");

export default function LotsPanel() {
  const { auth, logout } = useAuth();
  const [lots, setLots] = useState<Lot[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/lots`, { headers: { Authorization: `Bearer ${auth?.token}` } })
      .then((res) => {
        if (res.status === 401) {
          logout();
          throw new Error("session expired — please sign in again");
        }
        return res.json();
      })
      .then(setLots)
      .catch((err) => setError(String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth]);

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Lots (traceability)</h2>
      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}
      {lots.length === 0 && (
        <p style={{ color: "#898781" }}>
          No lots generated yet — a lot is created automatically when a work order is marked "completed".
        </p>
      )}
      {lots.map((l) => (
        <div key={l.id} style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 12, marginTop: 8, display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Lot #</div><div style={{ fontWeight: 600 }}>{l.lotNumber}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Order</div><div>{l.orderNumber}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Machine</div><div>{l.machineName ?? "—"}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Operator</div><div>{l.operatorEmail ?? "—"}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Good/Scrap</div><div>{l.goodCount} / {l.scrapCount}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Completed</div><div>{new Date(l.completedAt).toLocaleString()}</div></div>
        </div>
      ))}
    </section>
  );
}