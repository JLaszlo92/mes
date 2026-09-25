import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";

interface ShiftPattern {
  id: string;
  name: string;
}
interface Calendar {
  id: string;
  name: string;
}

interface Machine {
  id: string;
  name: string;
  assetType: string | null;
  location: string | null;
  idealCycleTimeSeconds: number | null;
  isActive: boolean;
  shiftPatternId: string | null;
  calendarId: string | null;
  autoOffshiftStatus: boolean;
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
const secondaryButtonStyle = {
  ...buttonStyle,
  background: "#fff",
  color: "#0b0b0b",
};

export default function MachineRegistryPanel() {
  const { auth, logout } = useAuth();
  const [shiftPatterns, setShiftPatterns] = useState<ShiftPattern[]>([]);
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [savingSchedulingId, setSavingSchedulingId] = useState<string | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ id: "", name: "", assetType: "", location: "", idealCycleTimeSeconds: "" });  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", assetType: "", location: "", idealCycleTimeSeconds: "" });
  const [savingId, setSavingId] = useState<string | null>(null);

  function load() {
    setLoading(true);
    fetch(`${API_BASE}/api/machine-registry`)
      .then((res) => res.json())
      .then((data: Machine[]) => {
        setMachines(data);
        setError(null);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
    fetch(`${API_BASE}/api/shift-patterns`, { headers: { Authorization: `Bearer ${auth?.token}` } })
      .then((r) => (r.ok ? r.json() : []))
      .then(setShiftPatterns);
    fetch(`${API_BASE}/api/calendars`, { headers: { Authorization: `Bearer ${auth?.token}` } })
      .then((r) => (r.ok ? r.json() : []))
      .then(setCalendars);
  }

  useEffect(load, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/machine-registry`, {
        method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth?.token}`,
          },        
          body: JSON.stringify({
          id: form.id.trim(),
          name: form.name.trim(),
          assetType: form.assetType.trim() || undefined,
          location: form.location.trim() || undefined,
          idealCycleTimeSeconds: form.idealCycleTimeSeconds ? Number(form.idealCycleTimeSeconds) : undefined,
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
      setForm({ id: "", name: "", assetType: "", location: "", idealCycleTimeSeconds: "" });
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(m: Machine) {
    setEditingId(m.id);
    setEditForm({
      name: m.name,
      assetType: m.assetType ?? "",
      location: m.location ?? "",
      idealCycleTimeSeconds: m.idealCycleTimeSeconds !== null ? String(m.idealCycleTimeSeconds) : "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit(id: string) {
    setSavingId(id);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/machine-registry/${encodeURIComponent(id)}`, {
        method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth?.token}`,
          },
          body: JSON.stringify({
            name: editForm.name.trim(),
            assetType: editForm.assetType.trim() || undefined,
            location: editForm.location.trim() || undefined,
            idealCycleTimeSeconds: editForm.idealCycleTimeSeconds ? Number(editForm.idealCycleTimeSeconds) : undefined,
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
      setEditingId(null);
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSavingId(null);
    }
  }

  async function updateScheduling(machineId: string, changes: { shiftPatternId?: string; calendarId?: string; autoOffshiftStatus?: boolean }) {
    setSavingSchedulingId(machineId);
    await fetch(`${API_BASE}/api/machine-registry/${encodeURIComponent(machineId)}/scheduling`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
      body: JSON.stringify(changes),
    });
    load();
    setSavingSchedulingId(null);
  }

  async function toggleActive(m: Machine) {
    setSavingId(m.id);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/machine-registry/${encodeURIComponent(m.id)}`, {
        method: "PUT",
        headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth?.token}`,
          },
        body: JSON.stringify({ isActive: !m.isActive }),
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
    } finally {
      setSavingId(null);
    }
  }

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Machine registry</h2>

      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
        <label style={{ fontSize: 12 }}>
          Machine ID<br />
          <input required value={form.id} onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))} placeholder="s7-rig-01" style={inputStyle} />
        </label>
        <label style={{ fontSize: 12 }}>
          Name<br />
          <input required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Press 3" style={inputStyle} />
        </label>
        <label style={{ fontSize: 12 }}>
          Type<br />
          <input value={form.assetType} onChange={(e) => setForm((f) => ({ ...f, assetType: e.target.value }))} placeholder="Hydraulic press" style={inputStyle} />
        </label>
        <label style={{ fontSize: 12 }}>
          Location<br />
          <input value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} placeholder="Line 1" style={inputStyle} />
        </label>
        <label style={{ fontSize: 12 }}>
            Ideal cycle (s)<br />
            <input type="number" step="0.1" value={form.idealCycleTimeSeconds} onChange={(e) => setForm((f) => ({ ...f, idealCycleTimeSeconds: e.target.value }))} style={{ ...inputStyle, width: 90 }} />
        </label>
        <button type="submit" disabled={submitting} style={buttonStyle}>
          {submitting ? "Adding…" : "Add machine"}
        </button>
      </form>

      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}
      {loading && <p style={{ color: "#898781" }}>Loading…</p>}
      {!loading && machines.length === 0 && <p style={{ color: "#898781" }}>No machines registered yet.</p>}

      {machines.map((m) => {
        const isEditing = editingId === m.id;
        const isSaving = savingId === m.id;

        if (isEditing) {
          return (
            <div key={m.id} style={{ border: "1px solid #0b0b0b", borderRadius: 10, padding: 12, marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div style={{ fontSize: 12, color: "#898781" }}>{m.id}</div>
              <label style={{ fontSize: 12 }}>
                Name<br />
                <input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} style={inputStyle} />
              </label>
              <label style={{ fontSize: 12 }}>
                Type<br />
                <input value={editForm.assetType} onChange={(e) => setEditForm((f) => ({ ...f, assetType: e.target.value }))} style={inputStyle} />
              </label>
              <label style={{ fontSize: 12 }}>
                Location<br />
                <input value={editForm.location} onChange={(e) => setEditForm((f) => ({ ...f, location: e.target.value }))} style={inputStyle} />
              </label>
              <label style={{ fontSize: 12 }}>
                Ideal cycle (s)<br />
                <input
                  type="number"
                  step="0.1"
                  value={editForm.idealCycleTimeSeconds}
                  onChange={(e) => setEditForm((f) => ({ ...f, idealCycleTimeSeconds: e.target.value }))}
                  style={inputStyle}
                />
              </label>
              <button type="button" onClick={() => saveEdit(m.id)} disabled={isSaving} style={buttonStyle}>
                {isSaving ? "Saving…" : "Save"}
              </button>
              <button type="button" onClick={cancelEdit} style={secondaryButtonStyle}>
                Cancel
              </button>
            </div>
          );
        }

        return (
          <div key={m.id} style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 12, marginTop: 8, display: "flex", gap: 20, alignItems: "center", opacity: m.isActive ? 1 : 0.5 }}>
            <div><div style={{ fontSize: 12, color: "#898781" }}>ID</div><div style={{ fontWeight: 600 }}>{m.id}</div></div>
            <div><div style={{ fontSize: 12, color: "#898781" }}>Name</div><div style={{ fontWeight: 600 }}>{m.name}</div></div>
            <div><div style={{ fontSize: 12, color: "#898781" }}>Type</div><div>{m.assetType ?? "—"}</div></div>
            <div><div style={{ fontSize: 12, color: "#898781" }}>Location</div><div>{m.location ?? "—"}</div></div>
            <div>
              <div style={{ fontSize: 12, color: "#898781" }}>Ideal cycle</div>
              <div>{m.idealCycleTimeSeconds ?? "—"}s</div>
            </div>
            {!m.isActive && <div style={{ fontSize: 12, color: "#d03b3b" }}>inactive</div>}
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <select value={m.shiftPatternId ?? ""} onChange={(e) => updateScheduling(m.id, { shiftPatternId: e.target.value })} style={{ ...inputStyle, fontSize: 12 }} disabled={savingSchedulingId === m.id}>
                {shiftPatterns.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <select value={m.calendarId ?? ""} onChange={(e) => updateScheduling(m.id, { calendarId: e.target.value })} style={{ ...inputStyle, fontSize: 12 }} disabled={savingSchedulingId === m.id}>
                {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <label style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 3 }}>
                <input type="checkbox" checked={m.autoOffshiftStatus} onChange={(e) => updateScheduling(m.id, { autoOffshiftStatus: e.target.checked })} disabled={savingSchedulingId === m.id} />
                Auto off-shift
              </label>
            </div>

            <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button type="button" onClick={() => startEdit(m)} style={secondaryButtonStyle}>
                Edit
              </button>
              <button type="button" onClick={() => toggleActive(m)} disabled={isSaving} style={secondaryButtonStyle}>
                {isSaving ? "…" : m.isActive ? "Deactivate" : "Activate"}
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}