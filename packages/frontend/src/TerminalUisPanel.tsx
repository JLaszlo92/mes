import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";

interface Machine {
  id: string;
  name: string;
}

interface TerminalUi {
  id: string;
  name: string;
  machineIds: string[];
  machineNames: string[];
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

export default function TerminalUisPanel() {
  const { auth, logout } = useAuth();
  const [uis, setUis] = useState<TerminalUi[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [selectedMachineIds, setSelectedMachineIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function load() {
    Promise.all([
      fetch(`${API_BASE}/api/terminal-uis`).then((r) => r.json()),
      fetch(`${API_BASE}/api/machine-registry`).then((r) => r.json()),
    ])
      .then(([u, m]) => {
        setUis(u);
        setMachines(m);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }

  useEffect(load, []);

  function toggleMachine(id: string) {
    setSelectedMachineIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/terminal-uis`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify({ name: name.trim(), machineIds: selectedMachineIds }),
      });
      if (res.status === 401) {
        logout();
        throw new Error("session expired — please sign in again");
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      }
      setName("");
      setSelectedMachineIds([]);
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
      const res = await fetch(`${API_BASE}/api/terminal-uis/${encodeURIComponent(id)}`, {
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
      <h2 style={{ fontSize: 16 }}>Terminal UIs</h2>

      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start", marginBottom: 16 }}>
        <label style={{ fontSize: 12 }}>
          Name<br />
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Line 1 terminal" style={inputStyle} />
        </label>
        <div style={{ fontSize: 12 }}>
          Machines<br />
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
            {machines.map((m) => (
              <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <input type="checkbox" checked={selectedMachineIds.includes(m.id)} onChange={() => toggleMachine(m.id)} />
                {m.name}
              </label>
            ))}
          </div>
        </div>
        <button type="submit" disabled={submitting} style={{ ...buttonStyle, alignSelf: "flex-end" }}>
          {submitting ? "Adding…" : "Add terminal UI"}
        </button>
      </form>

      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}
      {uis.length === 0 && <p style={{ color: "#898781" }}>No terminal UIs yet.</p>}

      {uis.map((ui) => (
        <div key={ui.id} style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 12, marginTop: 8, display: "flex", gap: 20, alignItems: "center" }}>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Name</div><div style={{ fontWeight: 600 }}>{ui.name}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Machines</div><div>{ui.machineNames.join(", ") || "—"}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>URL</div><code style={{ fontSize: 12 }}>/terminal/{ui.id}</code></div>
          <button type="button" onClick={() => remove(ui.id)} style={{ ...dangerButtonStyle, marginLeft: "auto" }}>
            Remove
          </button>
        </div>
      ))}
    </section>
  );
}