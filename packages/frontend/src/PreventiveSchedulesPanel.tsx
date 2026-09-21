import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";

interface Machine {
  id: string;
  name: string;
}

interface PreventiveSchedule {
  id: string;
  machineId: string;
  machineName: string;
  triggerType: "calendar" | "usage_hours" | "part_count";
  intervalValue: number;
  description: string;
  lastTriggeredAt: string | null;
  isActive: boolean;
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

const TRIGGER_UNIT: Record<string, string> = {
  calendar: "days",
  usage_hours: "running hours",
  part_count: "parts produced",
};

export default function PreventiveSchedulesPanel() {
  const { auth, logout } = useAuth();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [schedules, setSchedules] = useState<PreventiveSchedule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    machineId: "",
    triggerType: "calendar" as "calendar" | "usage_hours" | "part_count",
    intervalValue: "",
    description: "",
  });
  const [submitting, setSubmitting] = useState(false);

  const canManage = auth?.role === "maintenance" || auth?.role === "manager" || auth?.role === "admin";

  function load() {
    Promise.all([
      fetch(`${API_BASE}/api/machine-registry`).then((r) => r.json()),
      fetch(`${API_BASE}/api/preventive-schedules`, { headers: { Authorization: `Bearer ${auth?.token}` } }).then(
        (res) => {
          if (res.status === 401) {
            logout();
            throw new Error("session expired — please sign in again");
          }
          return res.json();
        },
      ),
    ])
      .then(([m, s]) => {
        setMachines(m);
        setSchedules(s);
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
      const res = await fetch(`${API_BASE}/api/preventive-schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify({
          machineId: form.machineId,
          triggerType: form.triggerType,
          intervalValue: Number(form.intervalValue),
          description: form.description.trim(),
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
      setForm({ machineId: "", triggerType: "calendar", intervalValue: "", description: "" });
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(id: string) {
    const res = await fetch(`${API_BASE}/api/preventive-schedules/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${auth?.token}` },
    });
    if (res.status === 401) {
      logout();
      return;
    }
    load();
  }

  if (!canManage) return null;

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Preventive maintenance schedules</h2>

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
          Trigger<br />
          <select
            value={form.triggerType}
            onChange={(e) => setForm((f) => ({ ...f, triggerType: e.target.value as "calendar" | "usage_hours" | "part_count" }))}
            style={inputStyle}
          >
            <option value="calendar">Calendar (days)</option>
            <option value="usage_hours">Usage (running hours)</option>
            <option value="part_count">Parts produced</option>
          </select>
        </label>
        <label style={{ fontSize: 12 }}>
          Every<br />
          <input required type="number" min="1" value={form.intervalValue} onChange={(e) => setForm((f) => ({ ...f, intervalValue: e.target.value }))} style={{ ...inputStyle, width: 90 }} />
          <span style={{ fontSize: 11, color: "#898781", marginLeft: 4 }}>{TRIGGER_UNIT[form.triggerType]}</span>
        </label>
        <label style={{ fontSize: 12, flex: "1 1 200px" }}>
          Task<br />
          <input required value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="Change oil" style={{ ...inputStyle, width: "100%" }} />
        </label>
        <button type="submit" disabled={submitting} style={buttonStyle}>
          {submitting ? "Adding…" : "Add schedule"}
        </button>
      </form>

      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}
      {schedules.filter((s) => s.isActive).length === 0 && <p style={{ color: "#898781" }}>No active schedules.</p>}

      {schedules.filter((s) => s.isActive).map((s) => (
        <div key={s.id} style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 12, marginTop: 8, display: "flex", gap: 20, alignItems: "center" }}>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Machine</div><div style={{ fontWeight: 600 }}>{s.machineName}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Task</div><div>{s.description}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Every</div><div>{s.intervalValue} {TRIGGER_UNIT[s.triggerType]}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Last done</div><div>{s.lastTriggeredAt ? new Date(s.lastTriggeredAt).toLocaleString() : "never"}</div></div>
          <button style={{ ...secondaryButtonStyle, marginLeft: "auto", color: "#d03b3b", borderColor: "#d03b3b" }} onClick={() => remove(s.id)}>
            Remove
          </button>
        </div>
      ))}
    </section>
  );
}