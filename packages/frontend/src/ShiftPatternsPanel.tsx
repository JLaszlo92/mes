import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";

interface Shift {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
}

interface ShiftPattern {
  id: string;
  name: string;
  shifts: Shift[];
}

interface Calendar {
  id: string;
  name: string;
  workingDays: boolean[];
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

export default function ShiftPatternsPanel() {
  const { auth, logout } = useAuth();
  const [patterns, setPatterns] = useState<ShiftPattern[]>([]);
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [newPatternName, setNewPatternName] = useState("");
  const [addingShiftFor, setAddingShiftFor] = useState<string | null>(null);
  const [shiftForm, setShiftForm] = useState({ name: "", startTime: "06:00", endTime: "14:00" });

  const [newCalendarName, setNewCalendarName] = useState("");
  const [newCalendarDays, setNewCalendarDays] = useState<boolean[]>([true, true, true, true, true, true, true]);

  function load() {
    const headers = { Authorization: `Bearer ${auth?.token}` };
    Promise.all([
      fetch(`${API_BASE}/api/shift-patterns`, { headers }).then((r) => (r.status === 401 ? (logout(), []) : r.json())),
      fetch(`${API_BASE}/api/calendars`, { headers }).then((r) => (r.status === 401 ? (logout(), []) : r.json())),
    ])
      .then(([p, c]) => {
        setPatterns(p);
        setCalendars(c);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }

  useEffect(load, []);

  async function createPattern(e: FormEvent) {
    e.preventDefault();
    const res = await fetch(`${API_BASE}/api/shift-patterns`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
      body: JSON.stringify({ name: newPatternName.trim() }),
    });
    if (res.ok) {
      setNewPatternName("");
      load();
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Failed to create pattern");
    }
  }

  async function deletePattern(id: string) {
    await fetch(`${API_BASE}/api/shift-patterns/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${auth?.token}` },
    });
    load();
  }

  async function addShift(patternId: string, e: FormEvent) {
    e.preventDefault();
    const res = await fetch(`${API_BASE}/api/shift-patterns/${encodeURIComponent(patternId)}/shifts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
      body: JSON.stringify(shiftForm),
    });
    if (res.ok) {
      setShiftForm({ name: "", startTime: "06:00", endTime: "14:00" });
      setAddingShiftFor(null);
      load();
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Failed to add shift");
    }
  }

  async function removeShift(shiftId: string) {
    await fetch(`${API_BASE}/api/shift-pattern-shifts/${encodeURIComponent(shiftId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${auth?.token}` },
    });
    load();
  }

  async function createCalendar(e: FormEvent) {
    e.preventDefault();
    const res = await fetch(`${API_BASE}/api/calendars`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
      body: JSON.stringify({ name: newCalendarName.trim(), workingDays: newCalendarDays }),
    });
    if (res.ok) {
      setNewCalendarName("");
      setNewCalendarDays([true, true, true, true, true, true, true]);
      load();
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Failed to create calendar");
    }
  }

  async function toggleCalendarDay(calendar: Calendar, day: number) {
    const updated = [...calendar.workingDays];
    updated[day] = !updated[day];
    await fetch(`${API_BASE}/api/calendars/${encodeURIComponent(calendar.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
      body: JSON.stringify({ workingDays: updated }),
    });
    load();
  }

  async function deleteCalendar(id: string) {
    await fetch(`${API_BASE}/api/calendars/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${auth?.token}` },
    });
    load();
  }

  return (
    <div>
      <section>
        <h2 style={{ fontSize: 16 }}>Shift patterns</h2>
        <form onSubmit={createPattern} style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 16 }}>
          <label style={{ fontSize: 12 }}>
            New pattern name<br />
            <input required value={newPatternName} onChange={(e) => setNewPatternName(e.target.value)} placeholder="Standard 3-shift" style={inputStyle} />
          </label>
          <button type="submit" style={buttonStyle}>Create pattern</button>
        </form>

        {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}

        {patterns.map((p) => (
          <div key={p.id} style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 12, marginTop: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 600 }}>{p.name}</div>
              <button onClick={() => deletePattern(p.id)} style={{ ...secondaryButtonStyle, color: "#d03b3b", borderColor: "#d03b3b" }}>
                Remove pattern
              </button>
            </div>
            {p.shifts.map((s) => (
              <div key={s.id} style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 13, padding: "6px 0", borderTop: "1px solid #f0efeb" }}>
                <span style={{ fontWeight: 600 }}>{s.name}</span>
                <span style={{ color: "#898781" }}>{s.startTime} → {s.endTime}</span>
                <button onClick={() => removeShift(s.id)} style={{ ...secondaryButtonStyle, marginLeft: "auto", padding: "3px 8px", fontSize: 11 }}>
                  Remove
                </button>
              </div>
            ))}
            {addingShiftFor === p.id ? (
              <form onSubmit={(e) => addShift(p.id, e)} style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "flex-end" }}>
                <label style={{ fontSize: 12 }}>
                  Name<br />
                  <input required value={shiftForm.name} onChange={(e) => setShiftForm((f) => ({ ...f, name: e.target.value }))} placeholder="day" style={inputStyle} />
                </label>
                <label style={{ fontSize: 12 }}>
                  Start<br />
                  <input required type="time" value={shiftForm.startTime} onChange={(e) => setShiftForm((f) => ({ ...f, startTime: e.target.value }))} style={inputStyle} />
                </label>
                <label style={{ fontSize: 12 }}>
                  End<br />
                  <input required type="time" value={shiftForm.endTime} onChange={(e) => setShiftForm((f) => ({ ...f, endTime: e.target.value }))} style={inputStyle} />
                </label>
                <button type="submit" style={buttonStyle}>Add</button>
                <button type="button" onClick={() => setAddingShiftFor(null)} style={secondaryButtonStyle}>Cancel</button>
              </form>
            ) : (
              <button onClick={() => setAddingShiftFor(p.id)} style={{ ...secondaryButtonStyle, marginTop: 8, fontSize: 12 }}>
                + Add shift
              </button>
            )}
          </div>
        ))}
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 16 }}>Calendars</h2>
        <form onSubmit={createCalendar} style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 16, flexWrap: "wrap" }}>
          <label style={{ fontSize: 12 }}>
            New calendar name<br />
            <input required value={newCalendarName} onChange={(e) => setNewCalendarName(e.target.value)} placeholder="Weekdays only" style={inputStyle} />
          </label>
          {DAY_LABELS.map((label, i) => (
            <label key={i} style={{ fontSize: 11, display: "flex", flexDirection: "column", alignItems: "center" }}>
              {label}
              <input
                type="checkbox"
                checked={newCalendarDays[i]}
                onChange={(e) => setNewCalendarDays((d) => d.map((v, idx) => (idx === i ? e.target.checked : v)))}
              />
            </label>
          ))}
          <button type="submit" style={buttonStyle}>Create calendar</button>
        </form>

        {calendars.map((c) => (
          <div key={c.id} style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 12, marginTop: 8, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontWeight: 600, minWidth: 140 }}>{c.name}</div>
            {DAY_LABELS.map((label, i) => (
              <label key={i} style={{ fontSize: 11, display: "flex", flexDirection: "column", alignItems: "center" }}>
                {label}
                <input type="checkbox" checked={c.workingDays[i]} onChange={() => toggleCalendarDay(c, i)} />
              </label>
            ))}
            <button onClick={() => deleteCalendar(c.id)} style={{ ...secondaryButtonStyle, marginLeft: "auto", color: "#d03b3b", borderColor: "#d03b3b" }}>
              Remove
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}