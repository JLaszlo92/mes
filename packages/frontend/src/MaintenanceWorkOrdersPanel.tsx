import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";

interface Machine {
  id: string;
  name: string;
}

interface MaintenanceWorkOrder {
  id: string;
  machineId: string;
  machineName: string;
  title: string;
  description: string | null;
  status: "open" | "assigned" | "in_progress" | "closed";
  assignedToEmail: string | null;
  createdByEmail: string | null;
  sourceType: string | null;
  createdAt: string;
  closedAt: string | null;
}

interface MaintenancePart {
  id: string;
  partName: string;
  quantity: number;
}

interface MaintenanceLabor {
  id: string;
  performedByEmail: string | null;
  hours: number;
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
const secondaryButtonStyle = { ...buttonStyle, background: "#fff", color: "#0b0b0b" };

const STATUS_COLOR: Record<string, string> = {
  open: "#898781",
  assigned: "#eda100",
  in_progress: "#185fa5",
  closed: "#0ca30c",
};

export default function MaintenanceWorkOrdersPanel() {
  const { auth, logout } = useAuth();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [orders, setOrders] = useState<MaintenanceWorkOrder[]>([]);
  const [partsByOrder, setPartsByOrder] = useState<Record<string, MaintenancePart[]>>({});
  const [laborByOrder, setLaborByOrder] = useState<Record<string, MaintenanceLabor[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ machineId: "", title: "", description: "" });
  const [submitting, setSubmitting] = useState(false);
  const [partDrafts, setPartDrafts] = useState<Record<string, string>>({});
  const [laborDrafts, setLaborDrafts] = useState<Record<string, string>>({});

  const canManage = auth?.role === "maintenance" || auth?.role === "manager" || auth?.role === "admin";

  function load() {
    Promise.all([
      fetch(`${API_BASE}/api/machine-registry`).then((r) => r.json()),
      fetch(`${API_BASE}/api/maintenance-work-orders`, { headers: { Authorization: `Bearer ${auth?.token}` } }).then(
        (res) => {
          if (res.status === 401) {
            logout();
            throw new Error("session expired — please sign in again");
          }
          return res.json();
        },
      ),
    ])
      .then(([m, mwo]) => {
        setMachines(m);
        setOrders(mwo);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }

  useEffect(load, []);

  async function loadDetails(orderId: string) {
    const [parts, labor] = await Promise.all([
      fetch(`${API_BASE}/api/maintenance-work-orders/${encodeURIComponent(orderId)}/parts`, {
        headers: { Authorization: `Bearer ${auth?.token}` },
      }).then((r) => (r.ok ? r.json() : [])),
      fetch(`${API_BASE}/api/maintenance-work-orders/${encodeURIComponent(orderId)}/labor`, {
        headers: { Authorization: `Bearer ${auth?.token}` },
      }).then((r) => (r.ok ? r.json() : [])),
    ]);
    setPartsByOrder((prev) => ({ ...prev, [orderId]: parts }));
    setLaborByOrder((prev) => ({ ...prev, [orderId]: labor }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/maintenance-work-orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify({
          machineId: form.machineId,
          title: form.title.trim(),
          description: form.description.trim() || undefined,
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
      setForm({ machineId: "", title: "", description: "" });
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function changeStatus(id: string, status: string) {
    const res = await fetch(`${API_BASE}/api/maintenance-work-orders/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
      body: JSON.stringify({ status }),
    });
    if (res.status === 401) {
      logout();
      return;
    }
    load();
  }

  async function addPart(orderId: string) {
    const partName = (partDrafts[orderId] ?? "").trim();
    if (!partName) return;
    await fetch(`${API_BASE}/api/maintenance-work-orders/${encodeURIComponent(orderId)}/parts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
      body: JSON.stringify({ partName, quantity: 1 }),
    });
    setPartDrafts((prev) => ({ ...prev, [orderId]: "" }));
    loadDetails(orderId);
  }

  async function addLabor(orderId: string) {
    const hours = Number(laborDrafts[orderId]);
    if (!hours || hours <= 0) return;
    await fetch(`${API_BASE}/api/maintenance-work-orders/${encodeURIComponent(orderId)}/labor`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
      body: JSON.stringify({ hours }),
    });
    setLaborDrafts((prev) => ({ ...prev, [orderId]: "" }));
    loadDetails(orderId);
  }

  const open = orders.filter((o) => o.status !== "closed");
  const closed = orders.filter((o) => o.status === "closed");

  function renderOrderDetails(o: MaintenanceWorkOrder) {
    const parts = partsByOrder[o.id];
    const labor = laborByOrder[o.id];
    return (
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #e1e0d9" }}>
        <div style={{ display: "flex", gap: 24 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: "#898781", marginBottom: 4 }}>Parts</div>
            {(parts ?? []).map((p) => (
              <div key={p.id} style={{ fontSize: 12 }}>{p.quantity}× {p.partName}</div>
            ))}
            {canManage && (
              <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                <input
                  placeholder="Part name"
                  value={partDrafts[o.id] ?? ""}
                  onChange={(e) => setPartDrafts((prev) => ({ ...prev, [o.id]: e.target.value }))}
                  style={{ ...inputStyle, fontSize: 12, flex: 1 }}
                />
                <button style={{ ...secondaryButtonStyle, fontSize: 11, padding: "3px 8px" }} onClick={() => addPart(o.id)}>
                  Add
                </button>
              </div>
            )}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: "#898781", marginBottom: 4 }}>Labor</div>
            {(labor ?? []).map((l) => (
              <div key={l.id} style={{ fontSize: 12 }}>{l.hours}h — {l.performedByEmail ?? "—"}</div>
            ))}
            {canManage && (
              <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                <input
                  type="number"
                  step="0.5"
                  placeholder="Hours"
                  value={laborDrafts[o.id] ?? ""}
                  onChange={(e) => setLaborDrafts((prev) => ({ ...prev, [o.id]: e.target.value }))}
                  style={{ ...inputStyle, fontSize: 12, width: 70 }}
                />
                <button style={{ ...secondaryButtonStyle, fontSize: 11, padding: "3px 8px" }} onClick={() => addLabor(o.id)}>
                  Log
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Maintenance work orders</h2>

      {canManage && (
        <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
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
            Title<br />
            <input required value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="Replace worn belt" style={inputStyle} />
          </label>
          <label style={{ fontSize: 12, flex: "1 1 200px" }}>
            Description<br />
            <input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} style={{ ...inputStyle, width: "100%" }} />
          </label>
          <button type="submit" disabled={submitting} style={buttonStyle}>
            {submitting ? "Creating…" : "Create"}
          </button>
        </form>
      )}

      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}
      {open.length === 0 && <p style={{ color: "#898781" }}>No open maintenance work orders.</p>}

      {open.map((o) => (
        <div key={o.id} style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 12, marginTop: 8 }}>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{o.machineName} — {o.title}</div>
              {o.description && <div style={{ fontSize: 13 }}>{o.description}</div>}
              <div style={{ fontSize: 11, color: "#898781" }}>
                created by {o.createdByEmail ?? "—"} · {new Date(o.createdAt).toLocaleString()}
                {o.sourceType && ` · via ${o.sourceType}`}
              </div>
            </div>
            {canManage ? (
              <select value={o.status} onChange={(e) => changeStatus(o.id, e.target.value)} style={{ ...inputStyle, color: STATUS_COLOR[o.status], fontWeight: 600 }}>
                <option value="open">open</option>
                <option value="assigned">assigned</option>
                <option value="in_progress">in_progress</option>
                <option value="closed">closed</option>
              </select>
            ) : (
              <span style={{ color: STATUS_COLOR[o.status], fontWeight: 600 }}>{o.status}</span>
            )}
          </div>
          {partsByOrder[o.id] === undefined ? (
            <button style={{ ...secondaryButtonStyle, marginTop: 8, fontSize: 12 }} onClick={() => loadDetails(o.id)}>
              Show parts &amp; labor
            </button>
          ) : (
            renderOrderDetails(o)
          )}
        </div>
      ))}

      {closed.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary style={{ fontSize: 13, color: "#898781", cursor: "pointer" }}>{closed.length} closed</summary>
          {closed.map((o) => (
            <div key={o.id} style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 12, marginTop: 8, opacity: 0.7 }}>
              <div style={{ fontWeight: 600 }}>{o.machineName} — {o.title}</div>
              <div style={{ fontSize: 11, color: "#898781" }}>closed {o.closedAt ? new Date(o.closedAt).toLocaleString() : ""}</div>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}