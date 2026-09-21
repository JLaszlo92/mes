import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";

interface Machine {
  id: string;
  name: string;
}

interface FaultCode {
  id: string;
  machineId: string;
  code: string;
  name: string;
  signalReference: string | null;
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

export default function MachineFaultCodesPanel() {
  const { auth, logout } = useAuth();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selectedMachineId, setSelectedMachineId] = useState("");
  const [faultCodes, setFaultCodes] = useState<FaultCode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ code: "", name: "", signalReference: "" });
  const [submitting, setSubmitting] = useState(false);

  const isAdmin = auth?.role === "admin" || auth?.role === "manager";

  useEffect(() => {
    fetch(`${API_BASE}/api/machine-registry`)
      .then((r) => r.json())
      .then((data: Machine[]) => {
        setMachines(data);
        if (data.length > 0 && !selectedMachineId) setSelectedMachineId(data[0].id);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadFaultCodes(machineId: string) {
    if (!machineId) return;
    fetch(`${API_BASE}/api/fault-codes?machineId=${encodeURIComponent(machineId)}`)
      .then((r) => r.json())
      .then(setFaultCodes)
      .catch((err) => setError(String(err)));
  }

  useEffect(() => {
    loadFaultCodes(selectedMachineId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMachineId]);

  const activeCodes = faultCodes.filter((f) => f.isActive);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/fault-codes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify({
          machineId: selectedMachineId,
          code: form.code.trim(),
          name: form.name.trim(),
          signalReference: form.signalReference.trim() || undefined,
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
      setForm({ code: "", name: "", signalReference: "" });
      loadFaultCodes(selectedMachineId);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(id: string) {
    const res = await fetch(`${API_BASE}/api/fault-codes/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${auth?.token}` },
    });
    if (res.status === 401) {
      logout();
      return;
    }
    loadFaultCodes(selectedMachineId);
  }

  if (!isAdmin) return null;

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Machine fault codes</h2>

      <label style={{ fontSize: 12 }}>
        Machine<br />
        <select value={selectedMachineId} onChange={(e) => setSelectedMachineId(e.target.value)} style={inputStyle}>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      </label>

      <p style={{ fontSize: 12, color: "#898781", marginTop: 8 }}>
        {activeCodes.length} / 10 fault codes defined for this machine.
      </p>

      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 8, marginBottom: 16 }}>
        <label style={{ fontSize: 12 }}>
          Code<br />
          <input required value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} placeholder="E01" style={{ ...inputStyle, width: 80 }} />
        </label>
        <label style={{ fontSize: 12 }}>
          Name<br />
          <input required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Sensor jam" style={inputStyle} />
        </label>
        <label style={{ fontSize: 12 }}>
          Signal reference (optional)<br />
          <input value={form.signalReference} onChange={(e) => setForm((f) => ({ ...f, signalReference: e.target.value }))} placeholder="S7 DB1.DBX2.3" style={inputStyle} />
        </label>
        <button type="submit" disabled={submitting || activeCodes.length >= 10} style={buttonStyle}>
          {submitting ? "Adding…" : "Add code"}
        </button>
      </form>

      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}

      {activeCodes.map((f) => (
        <div key={f.id} style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 12, marginTop: 8, display: "flex", gap: 20, alignItems: "center" }}>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Code</div><div style={{ fontWeight: 600 }}>{f.code}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Name</div><div>{f.name}</div></div>
          <div><div style={{ fontSize: 12, color: "#898781" }}>Signal</div><div>{f.signalReference ?? "—"}</div></div>
          <button type="button" onClick={() => remove(f.id)} style={{ ...secondaryButtonStyle, marginLeft: "auto", color: "#d03b3b", borderColor: "#d03b3b" }}>
            Remove
          </button>
        </div>
      ))}
    </section>
  );
}