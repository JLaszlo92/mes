import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";

interface Alert {
  id: string;
  machineId: string;
  machineName: string;
  type: string;
  message: string;
  raisedAt: string;
  resolvedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
}

interface AlertRule {
  id: string;
  type: "machine_down" | "scrap_rate";
  machineId: string | null;
  threshold: number;
  notifyRoles: string[];
  isActive: boolean;
}

interface Machine {
  id: string;
  name: string;
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
const ROLES = ["operator", "supervisor", "maintenance", "manager", "admin"];

export default function AlertsPanel() {
  const { auth, logout } = useAuth();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    type: "machine_down" as "machine_down" | "scrap_rate",
    machineId: "",
    threshold: "",
    notifyRoles: ["supervisor", "manager"] as string[],
  });
  const [submitting, setSubmitting] = useState(false);

  const isAdmin = auth?.role === "admin" || auth?.role === "manager";

  function load() {
    const calls: Promise<void>[] = [
      fetch(`${API_BASE}/api/alerts`).then((r) => r.json()).then(setAlerts),
      fetch(`${API_BASE}/api/machine-registry`).then((r) => r.json()).then(setMachines),
    ];
    if (isAdmin) {
      calls.push(
        fetch(`${API_BASE}/api/alert-rules`, { headers: { Authorization: `Bearer ${auth?.token}` } })
          .then((r) => r.json())
          .then(setRules),
      );
    }
    Promise.all(calls).catch((err) => setError(String(err)));
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function acknowledge(id: string) {
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/alerts/${encodeURIComponent(id)}/acknowledge`, {
        method: "POST",
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

  function toggleRole(role: string) {
    setForm((f) => ({
      ...f,
      notifyRoles: f.notifyRoles.includes(role) ? f.notifyRoles.filter((r) => r !== role) : [...f.notifyRoles, role],
    }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/alert-rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify({
          type: form.type,
          machineId: form.machineId || undefined,
          threshold: Number(form.threshold),
          notifyRoles: form.notifyRoles,
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
      setForm({ type: "machine_down", machineId: "", threshold: "", notifyRoles: ["supervisor", "manager"] });
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleRuleActive(rule: AlertRule) {
    await fetch(`${API_BASE}/api/alert-rules/${encodeURIComponent(rule.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
      body: JSON.stringify({ isActive: !rule.isActive }),
    });
    load();
  }

  async function removeRule(id: string) {
    await fetch(`${API_BASE}/api/alert-rules/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${auth?.token}` },
    });
    load();
  }

  const openAlerts = alerts.filter((a) => !a.resolvedAt);
  const machineName = (id: string) => machines.find((m) => m.id === id)?.name ?? id;

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Alerts</h2>

      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}
      {openAlerts.length === 0 && <p style={{ color: "#898781" }}>No active alerts.</p>}

      {openAlerts.map((a) => (
        <div
          key={a.id}
          style={{ border: "1px solid #d03b3b", background: "#fdf0f0", borderRadius: 10, padding: 12, marginTop: 8, display: "flex", alignItems: "center", gap: 16 }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{a.machineName}</div>
            <div style={{ fontSize: 13 }}>{a.message}</div>
            <div style={{ fontSize: 11, color: "#898781" }}>{new Date(a.raisedAt).toLocaleString()}</div>
          </div>
          {a.acknowledgedAt ? (
            <span style={{ fontSize: 12, color: "#898781" }}>Acknowledged</span>
          ) : (
            <button style={secondaryButtonStyle} onClick={() => acknowledge(a.id)}>
              Acknowledge
            </button>
          )}
        </div>
      ))}

      {isAdmin && (
        <>
          <h3 style={{ fontSize: 14, marginTop: 24 }}>Alert rules</h3>
          <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
            <label style={{ fontSize: 12 }}>
              Type<br />
              <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as "machine_down" | "scrap_rate" }))} style={inputStyle}>
                <option value="machine_down">Machine down (minutes)</option>
                <option value="scrap_rate">Scrap rate (%)</option>
              </select>
            </label>
            <label style={{ fontSize: 12 }}>
              Machine<br />
              <select value={form.machineId} onChange={(e) => setForm((f) => ({ ...f, machineId: e.target.value }))} style={inputStyle}>
                <option value="">All machines</option>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: 12 }}>
              Threshold<br />
              <input required type="number" value={form.threshold} onChange={(e) => setForm((f) => ({ ...f, threshold: e.target.value }))} style={{ ...inputStyle, width: 80 }} />
            </label>
            <div style={{ fontSize: 12 }}>
              Notify<br />
              <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                {ROLES.map((role) => (
                  <label key={role} style={{ display: "flex", alignItems: "center", gap: 2 }}>
                    <input type="checkbox" checked={form.notifyRoles.includes(role)} onChange={() => toggleRole(role)} />
                    {role}
                  </label>
                ))}
              </div>
            </div>
            <button type="submit" disabled={submitting} style={buttonStyle}>
              {submitting ? "Adding…" : "Add rule"}
            </button>
          </form>

          {rules.map((r) => (
            <div key={r.id} style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 12, marginTop: 8, display: "flex", gap: 20, alignItems: "center", opacity: r.isActive ? 1 : 0.5 }}>
              <div><div style={{ fontSize: 12, color: "#898781" }}>Type</div><div>{r.type}</div></div>
              <div><div style={{ fontSize: 12, color: "#898781" }}>Machine</div><div>{r.machineId ? machineName(r.machineId) : "All"}</div></div>
              <div><div style={{ fontSize: 12, color: "#898781" }}>Threshold</div><div>{r.threshold}</div></div>
              <div><div style={{ fontSize: 12, color: "#898781" }}>Notify</div><div>{r.notifyRoles.join(", ")}</div></div>
              <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                <button type="button" onClick={() => toggleRuleActive(r)} style={secondaryButtonStyle}>
                  {r.isActive ? "Disable" : "Enable"}
                </button>
                <button type="button" onClick={() => removeRule(r.id)} style={{ ...secondaryButtonStyle, color: "#d03b3b", borderColor: "#d03b3b" }}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </section>
  );
}