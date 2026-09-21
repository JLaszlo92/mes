import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";

interface WorkOrder {
  id: string;
  orderNumber: string;
  partName: string;
  status: string;
}

interface Machine {
  id: string;
  name: string;
}

interface Assignment {
  id: string;
  workOrderId: string;
  machineId: string;
  plannedStart: string;
  plannedEnd: string;
  orderNumber: string;
  partName: string;
  quantity: number;
  machineName: string;
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
const dangerButtonStyle = { ...buttonStyle, background: "#fff", color: "#d03b3b", borderColor: "#d03b3b" };

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function SchedulePanel() {
  const { auth, logout } = useAuth();
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ workOrderId: "", machineId: "", plannedStart: "", plannedEnd: "" });
  const [submitting, setSubmitting] = useState(false);

  function load() {
    Promise.all([
      fetch(`${API_BASE}/api/work-order-assignments`).then((r) => r.json()),
      fetch(`${API_BASE}/api/work-orders`).then((r) => r.json()),
      fetch(`${API_BASE}/api/machine-registry`).then((r) => r.json()),
    ])
      .then(([a, wo, m]) => {
        setAssignments(a);
        setWorkOrders(wo);
        setMachines(m);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }

  useEffect(load, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/work-order-assignments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify({
          workOrderId: form.workOrderId,
          machineId: form.machineId,
          plannedStart: new Date(form.plannedStart).toISOString(),
          plannedEnd: new Date(form.plannedEnd).toISOString(),
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
      setForm({ workOrderId: "", machineId: "", plannedStart: "", plannedEnd: "" });
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/work-order-assignments/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${auth?.token}` },
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
      <h2 style={{ fontSize: 16 }}>Schedule</h2>

      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
        <label style={{ fontSize: 12 }}>
          Work order<br />
          <select required value={form.workOrderId} onChange={(e) => setForm((f) => ({ ...f, workOrderId: e.target.value }))} style={inputStyle}>
            <option value="" disabled>select…</option>
            {workOrders.map((wo) => (
              <option key={wo.id} value={wo.id}>{wo.orderNumber} — {wo.partName}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>
          Machine<br />
          <select required value={form.machineId} onChange={(e) => setForm((f) => ({ ...f, machineId: e.target.value }))} style={inputStyle}>
            <option value="" disabled>select…</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>
          Start<br />
          <input required type="datetime-local" value={form.plannedStart} onChange={(e) => setForm((f) => ({ ...f, plannedStart: e.target.value }))} style={inputStyle} />
        </label>
        <label style={{ fontSize: 12 }}>
          End<br />
          <input required type="datetime-local" value={form.plannedEnd} onChange={(e) => setForm((f) => ({ ...f, plannedEnd: e.target.value }))} style={inputStyle} />
        </label>
        <button type="submit" disabled={submitting} style={buttonStyle}>
          {submitting ? "Assigning…" : "Assign"}
        </button>
      </form>

      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}
      {assignments.length === 0 && <p style={{ color: "#898781" }}>No assignments yet.</p>}

      {assignments.map((a) => (
        <div key={a.id} style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 12, marginTop: 8, display: "flex", gap: 20, alignItems: "center" }}>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Machine</div><div style={{ fontWeight: 600 }}>{a.machineName}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Order</div><div>{a.orderNumber} — {a.partName}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Qty</div><div>{a.quantity}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Window</div><div style={{ fontSize: 13 }}>{toLocalInputValue(a.plannedStart)} → {toLocalInputValue(a.plannedEnd)}</div></div>
          <button type="button" onClick={() => remove(a.id)} style={{ ...dangerButtonStyle, marginLeft: "auto" }}>
            Remove
          </button>
        </div>
      ))}
    </section>
  );
}