import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";

interface MaterialLot {
  id: string;
  materialName: string;
  lotNumber: string;
  supplier: string | null;
  receivedAt: string | null;
}

interface WorkOrder {
  id: string;
  orderNumber: string;
}

interface Consumption {
  materialLotId: string;
  materialName: string;
  lotNumber: string;
  recordedAt: string;
}

const WS_URL = import.meta.env.VITE_BACKEND_WS_URL ?? "ws://localhost:3001/ws";
const API_BASE = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");

const inputStyle = { padding: 6, border: "1px solid #e1e0d9", borderRadius: 6 };
const buttonStyle = {
  padding: "6px 12px",
  border: "1px solid #0b0b0b",
  borderRadius: 6,
  background: "#0b0b0b",
  color: "#fff",
  cursor: "pointer",
  fontSize: 13,
};

export default function MaterialLotsPanel() {
  const { auth, logout } = useAuth();
  const [materialLots, setMaterialLots] = useState<MaterialLot[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [consumptionByWorkOrder, setConsumptionByWorkOrder] = useState<Record<string, Consumption[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [lotForm, setLotForm] = useState({ materialName: "", lotNumber: "", supplier: "", receivedAt: "" });
  const [consumeForm, setConsumeForm] = useState({ workOrderId: "", materialLotId: "" });
  const [submitting, setSubmitting] = useState(false);

  function load() {
    Promise.all([
      fetch(`${API_BASE}/api/material-lots`, { headers: { Authorization: `Bearer ${auth?.token}` } }).then((res) => {
        if (res.status === 401) {
          logout();
          throw new Error("session expired — please sign in again");
        }
        return res.json();
      }),
      fetch(`${API_BASE}/api/work-orders`).then((r) => r.json()),
    ])
      .then(([ml, wo]) => {
        setMaterialLots(ml);
        setWorkOrders(wo);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }

  useEffect(load, []);

  async function loadConsumption(workOrderId: string) {
    if (!workOrderId) return;
    const res = await fetch(`${API_BASE}/api/work-orders/${encodeURIComponent(workOrderId)}/material-consumption`, {
      headers: { Authorization: `Bearer ${auth?.token}` },
    });
    if (res.ok) {
      const data = await res.json();
      setConsumptionByWorkOrder((prev) => ({ ...prev, [workOrderId]: data }));
    }
  }

  async function handleAddLot(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/material-lots`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify({
          materialName: lotForm.materialName.trim(),
          lotNumber: lotForm.lotNumber.trim(),
          supplier: lotForm.supplier.trim() || undefined,
          receivedAt: lotForm.receivedAt || undefined,
        }),
      });
      if (res.status === 401) {
        logout();
        throw new Error("session expired — please sign in again");
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      }
      setLotForm({ materialName: "", lotNumber: "", supplier: "", receivedAt: "" });
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConsume(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await fetch(
        `${API_BASE}/api/work-orders/${encodeURIComponent(consumeForm.workOrderId)}/material-consumption`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
          body: JSON.stringify({ materialLotId: consumeForm.materialLotId }),
        },
      );
      if (res.status === 401) {
        logout();
        throw new Error("session expired — please sign in again");
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      }
      loadConsumption(consumeForm.workOrderId);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Material lots</h2>

      <form onSubmit={handleAddLot} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
        <label style={{ fontSize: 12 }}>
          Material<br />
          <input required value={lotForm.materialName} onChange={(e) => setLotForm((f) => ({ ...f, materialName: e.target.value }))} placeholder="Aluminium sheet" style={inputStyle} />
        </label>
        <label style={{ fontSize: 12 }}>
          Lot number<br />
          <input required value={lotForm.lotNumber} onChange={(e) => setLotForm((f) => ({ ...f, lotNumber: e.target.value }))} placeholder="AL-2026-0091" style={inputStyle} />
        </label>
        <label style={{ fontSize: 12 }}>
          Supplier<br />
          <input value={lotForm.supplier} onChange={(e) => setLotForm((f) => ({ ...f, supplier: e.target.value }))} style={inputStyle} />
        </label>
        <label style={{ fontSize: 12 }}>
          Received<br />
          <input type="date" value={lotForm.receivedAt} onChange={(e) => setLotForm((f) => ({ ...f, receivedAt: e.target.value }))} style={inputStyle} />
        </label>
        <button type="submit" disabled={submitting} style={buttonStyle}>
          {submitting ? "Adding…" : "Add material lot"}
        </button>
      </form>

      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}

      {materialLots.map((ml) => (
        <div key={ml.id} style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 12, marginTop: 8, display: "flex", gap: 20, alignItems: "center" }}>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Material</div><div style={{ fontWeight: 600 }}>{ml.materialName}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Lot #</div><div>{ml.lotNumber}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Supplier</div><div>{ml.supplier ?? "—"}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Received</div><div>{ml.receivedAt ?? "—"}</div></div>
        </div>
      ))}

      <h3 style={{ fontSize: 14, marginTop: 24 }}>Record consumption for a work order</h3>
      <form onSubmit={handleConsume} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
        <label style={{ fontSize: 12 }}>
          Work order<br />
          <select
            required
            value={consumeForm.workOrderId}
            onChange={(e) => {
              setConsumeForm((f) => ({ ...f, workOrderId: e.target.value }));
              loadConsumption(e.target.value);
            }}
            style={inputStyle}
          >
            <option value="" disabled>select…</option>
            {workOrders.map((wo) => (
              <option key={wo.id} value={wo.id}>{wo.orderNumber}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>
          Material lot<br />
          <select required value={consumeForm.materialLotId} onChange={(e) => setConsumeForm((f) => ({ ...f, materialLotId: e.target.value }))} style={inputStyle}>
            <option value="" disabled>select…</option>
            {materialLots.map((ml) => (
              <option key={ml.id} value={ml.id}>{ml.materialName} — {ml.lotNumber}</option>
            ))}
          </select>
        </label>
        <button type="submit" style={buttonStyle}>
          Record
        </button>
      </form>

      {consumeForm.workOrderId && consumptionByWorkOrder[consumeForm.workOrderId] && (
        <div style={{ fontSize: 13 }}>
          Consumed so far:{" "}
          {consumptionByWorkOrder[consumeForm.workOrderId].map((c) => `${c.materialName} (${c.lotNumber})`).join(", ") || "none yet"}
        </div>
      )}
    </section>
  );
}