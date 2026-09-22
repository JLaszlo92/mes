import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";

interface Machine {
  id: string;
  name: string;
}

interface StatusDefinition {
  id: string;
  machineId: string | null;
  code: string;
  displayName: string;
  oeeCategory: "counts_as_down" | "excluded";
  color: string | null;
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

export default function MachineStatusDefinitionsPanel() {
  const { auth, logout } = useAuth();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [definitions, setDefinitions] = useState<StatusDefinition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    machineId: "",
    code: "",
    displayName: "",
    oeeCategory: "counts_as_down" as "counts_as_down" | "excluded",
    color: "#898781",
  });
  const [submitting, setSubmitting] = useState(false);

  const isAdmin = auth?.role === "admin" || auth?.role === "manager";

  function load() {
    Promise.all([
      fetch(`${API_BASE}/api/machine-registry`).then((r) => r.json()),
      fetch(`${API_BASE}/api/status-definitions`, { headers: { Authorization: `Bearer ${auth?.token}` } }).then(
        (res) => {
          if (res.status === 401) {
            logout();
            throw new Error("session expired — please sign in again");
          }
          return res.json();
        },
      ),
    ])
      .then(([m, d]) => {
        setMachines(m);
        setDefinitions(d);
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
      const res = await fetch(`${API_BASE}/api/status-definitions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify({
          machineId: form.machineId || undefined,
          code: form.code.trim(),
          displayName: form.displayName.trim(),
          oeeCategory: form.oeeCategory,
          color: form.color,
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
      setForm({ machineId: "", code: "", displayName: "", oeeCategory: "counts_as_down", color: "#898781" });
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(id: string) {
    const res = await fetch(`${API_BASE}/api/status-definitions/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${auth?.token}` },
    });
    if (res.status === 401) {
      logout();
      return;
    }
    load();
  }

  if (!isAdmin) return null;

  const machineName = (id: string | null) =>
    id ? machines.find((m) => m.id === id)?.name ?? id : "All machines (global default)";

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Custom machine statuses</h2>
      <p style={{ fontSize: 12, color: "#898781" }}>
        "running" and "down" are always built in. Add any additional status your machines can report — each one
        needs an OEE classification.
      </p>

      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
        <label style={{ fontSize: 12 }}>
          Machine<br />
          <select value={form.machineId} onChange={(e) => setForm((f) => ({ ...f, machineId: e.target.value }))} style={inputStyle}>
            <option value="">All machines (global default)</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>
          Code<br />
          <input required value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} placeholder="material_wait" style={inputStyle} />
        </label>
        <label style={{ fontSize: 12 }}>
          Display name<br />
          <input required value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} placeholder="Material shortage" style={inputStyle} />
        </label>
        <label style={{ fontSize: 12 }}>
          OEE category<br />
          <select
            value={form.oeeCategory}
            onChange={(e) => setForm((f) => ({ ...f, oeeCategory: e.target.value as "counts_as_down" | "excluded" }))}
            style={inputStyle}
          >
            <option value="counts_as_down">Counts as down (hurts availability)</option>
            <option value="excluded">Excluded (planned — no OEE impact)</option>
          </select>
        </label>
        <label style={{ fontSize: 12 }}>
          Color<br />
          <input type="color" value={form.color} onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))} style={{ ...inputStyle, padding: 2, width: 50 }} />
        </label>
        <button type="submit" disabled={submitting} style={buttonStyle}>
          {submitting ? "Adding…" : "Add status"}
        </button>
      </form>

      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}

      {definitions.map((d) => (
        <div key={d.id} style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 12, marginTop: 8, display: "flex", gap: 20, alignItems: "center" }}>
          <span style={{ width: 12, height: 12, borderRadius: "50%", background: d.color ?? "#898781", display: "inline-block" }} />
          <div><div style={{ fontSize: 12, color: "#898781" }}>Code</div><div style={{ fontWeight: 600 }}>{d.code}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Name</div><div>{d.displayName}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Scope</div><div>{machineName(d.machineId)}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>OEE</div><div>{d.oeeCategory === "counts_as_down" ? "Counts as down" : "Excluded (planned)"}</div></div>
          <button style={{ ...secondaryButtonStyle, marginLeft: "auto", color: "#d03b3b", borderColor: "#d03b3b" }} onClick={() => remove(d.id)}>
            Remove
          </button>
        </div>
      ))}
    </section>
  );
}