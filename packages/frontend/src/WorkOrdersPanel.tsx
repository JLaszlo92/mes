import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";

interface WorkOrder {
  id: string;
  orderNumber: string;
  partName: string;
  quantity: number;
  expectedCycleTimeSeconds: number | null;
  dueDate: string | null;
  status: string;
  notes: string | null;
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

const STATUS_COLOR: Record<string, string> = {
  planned: "#898781",
  released: "#eda100",
  in_progress: "#0ca30c",
  completed: "#185fa5",
  cancelled: "#d03b3b",
};

export default function WorkOrdersPanel() {
  const { auth, logout } = useAuth();
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    orderNumber: "",
    partName: "",
    quantity: "",
    expectedCycleTimeSeconds: "",
    dueDate: "",
  });
  const [submitting, setSubmitting] = useState(false);

  function load() {
    setLoading(true);
    fetch(`${API_BASE}/api/work-orders`)
      .then((res) => res.json())
      .then((data: WorkOrder[]) => {
        setWorkOrders(data);
        setError(null);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/work-orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify({
          orderNumber: form.orderNumber.trim(),
          partName: form.partName.trim(),
          quantity: Number(form.quantity),
          expectedCycleTimeSeconds: form.expectedCycleTimeSeconds ? Number(form.expectedCycleTimeSeconds) : undefined,
          dueDate: form.dueDate || undefined,
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
      setForm({ orderNumber: "", partName: "", quantity: "", expectedCycleTimeSeconds: "", dueDate: "" });
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function changeStatus(id: string, status: string) {
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/work-orders/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify({ status }),
      });
      if (res.status === 401) {
        logout();
        throw new Error("session expired — please sign in again");
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      }
      load();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Work orders</h2>

      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
        <label style={{ fontSize: 12 }}>
          Order #<br />
          <input required value={form.orderNumber} onChange={(e) => setForm((f) => ({ ...f, orderNumber: e.target.value }))} placeholder="WO-2026-0341" style={inputStyle} />
        </label>
        <label style={{ fontSize: 12 }}>
          Part<br />
          <input required value={form.partName} onChange={(e) => setForm((f) => ({ ...f, partName: e.target.value }))} placeholder="Bracket A-12" style={inputStyle} />
        </label>
        <label style={{ fontSize: 12 }}>
          Quantity<br />
          <input required type="number" min="1" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} style={{ ...inputStyle, width: 90 }} />
        </label>
        <label style={{ fontSize: 12 }}>
          Cycle time (s)<br />
          <input type="number" step="0.1" value={form.expectedCycleTimeSeconds} onChange={(e) => setForm((f) => ({ ...f, expectedCycleTimeSeconds: e.target.value }))} style={{ ...inputStyle, width: 100 }} />
        </label>
        <label style={{ fontSize: 12 }}>
          Due date<br />
          <input type="date" value={form.dueDate} onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))} style={inputStyle} />
        </label>
        <button type="submit" disabled={submitting} style={buttonStyle}>
          {submitting ? "Adding…" : "Add order"}
        </button>
      </form>

      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}
      {loading && <p style={{ color: "#898781" }}>Loading…</p>}
      {!loading && workOrders.length === 0 && <p style={{ color: "#898781" }}>No work orders yet.</p>}

      {workOrders.map((wo) => (
        <div key={wo.id} style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 12, marginTop: 8, display: "flex", gap: 20, alignItems: "center" }}>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Order #</div><div style={{ fontWeight: 600 }}>{wo.orderNumber}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Part</div><div>{wo.partName}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Qty</div><div style={{ fontVariantNumeric: "tabular-nums" }}>{wo.quantity}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Cycle</div><div>{wo.expectedCycleTimeSeconds ?? "—"}s</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Due</div><div>{wo.dueDate ?? "—"}</div></div>
          <div>
            <div style={{ fontSize: 12, color: "#898781" }}>Status</div>
            <select value={wo.status} onChange={(e) => changeStatus(wo.id, e.target.value)} style={{ ...inputStyle, color: STATUS_COLOR[wo.status], fontWeight: 600 }}>
              <option value="planned">planned</option>
              <option value="released">released</option>
              <option value="in_progress">in_progress</option>
              <option value="completed">completed</option>
              <option value="cancelled">cancelled</option>
            </select>
          </div>
        </div>
      ))}
    </section>
  );
}