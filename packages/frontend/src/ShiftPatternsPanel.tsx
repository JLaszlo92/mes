import { useEffect, useState, type FormEvent } from "react";
import { apiFetch, API_BASE } from "./api.js";

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

/** A backend hibaüzenete, vagy egy általános üzenet, ha a válasz nem JSON. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `${fallback} (${res.status})`;
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export default function ShiftPatternsPanel() {
  const [patterns, setPatterns] = useState<ShiftPattern[]>([]);
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Azok a naptárak, amelyeknek épp fut a mentése — addig a jelölőnégyzeteik zárolva vannak. */
  const [savingCalendarIds, setSavingCalendarIds] = useState<Set<string>>(new Set());

  const [newPatternName, setNewPatternName] = useState("");
  const [addingShiftFor, setAddingShiftFor] = useState<string | null>(null);
  const [shiftForm, setShiftForm] = useState({ name: "", startTime: "06:00", endTime: "14:00" });

  const [newCalendarName, setNewCalendarName] = useState("");
  const [newCalendarDays, setNewCalendarDays] = useState<boolean[]>([true, true, true, true, true, true, true]);

  // A token hozzáadását és a 401-es kiléptetést az apiFetch végzi.
  async function load() {
    try {
      const [p, c] = await Promise.all([
        apiFetch(`${API_BASE}/api/shift-patterns`).then((r) =>
          r.ok ? r.json() : Promise.reject(new Error(`loading shift patterns failed (${r.status})`)),
        ),
        apiFetch(`${API_BASE}/api/calendars`).then((r) =>
          r.ok ? r.json() : Promise.reject(new Error(`loading calendars failed (${r.status})`)),
        ),
      ]);
      setPatterns(p as ShiftPattern[]);
      setCalendars(c as Calendar[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  /**
   * Egy módosító kérés egységes kezelése: siker esetén törli a hibaüzenetet,
   * hiba esetén megjeleníti a backend üzenetét (pl. 409: "still assigned to a
   * machine" — korábban csendben elnyelődött). Mindkét esetben újratölt, így
   * a UI a szerver tényleges állapotát mutatja.
   */
  async function mutate(request: () => Promise<Response>, fallback: string): Promise<boolean> {
    let ok = false;
    try {
      const res = await request();
      ok = res.ok;
      if (ok) setError(null);
      else setError(await errorMessage(res, fallback));
    } catch (err) {
      setError(`${fallback}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await load();
    return ok;
  }

  async function createPattern(e: FormEvent) {
    e.preventDefault();
    const ok = await mutate(
      () => apiFetch(`${API_BASE}/api/shift-patterns`, jsonRequest("POST", { name: newPatternName.trim() })),
      "Failed to create pattern",
    );
    if (ok) setNewPatternName("");
  }

  function deletePattern(id: string) {
    return mutate(
      () => apiFetch(`${API_BASE}/api/shift-patterns/${encodeURIComponent(id)}`, { method: "DELETE" }),
      "Failed to remove pattern",
    );
  }

  async function addShift(patternId: string, e: FormEvent) {
    e.preventDefault();
    const ok = await mutate(
      () =>
        apiFetch(`${API_BASE}/api/shift-patterns/${encodeURIComponent(patternId)}/shifts`, jsonRequest("POST", shiftForm)),
      "Failed to add shift",
    );
    if (ok) {
      setShiftForm({ name: "", startTime: "06:00", endTime: "14:00" });
      setAddingShiftFor(null);
    }
  }

  function removeShift(shiftId: string) {
    return mutate(
      () => apiFetch(`${API_BASE}/api/shift-pattern-shifts/${encodeURIComponent(shiftId)}`, { method: "DELETE" }),
      "Failed to remove shift",
    );
  }

  async function createCalendar(e: FormEvent) {
    e.preventDefault();
    const ok = await mutate(
      () =>
        apiFetch(
          `${API_BASE}/api/calendars`,
          jsonRequest("POST", { name: newCalendarName.trim(), workingDays: newCalendarDays }),
        ),
      "Failed to create calendar",
    );
    if (ok) {
      setNewCalendarName("");
      setNewCalendarDays([true, true, true, true, true, true, true]);
    }
  }

  /**
   * Egy nap be/ki kapcsolása. Korábban az új tömb a legutóbb BETÖLTÖTT
   * állapotból készült, így két gyors kattintásnál a második kérés nem
   * tartalmazta az elsőt, és felülírta — az egyik módosítás elveszett.
   * Most az új tömb a legfrissebb helyi állapotból készül, azonnal megjelenik
   * (optimista frissítés), és amíg a mentés fut, az adott naptár
   * jelölőnégyzetei zárolva vannak, így nem indulhat egymást átfedő kérés.
   */
  async function toggleCalendarDay(calendarId: string, day: number) {
    if (savingCalendarIds.has(calendarId)) return;
    const current = calendars.find((c) => c.id === calendarId);
    if (!current) return;
    const updated = current.workingDays.map((v, i) => (i === day ? !v : v));

    setCalendars((prev) => prev.map((c) => (c.id === calendarId ? { ...c, workingDays: updated } : c)));
    setSavingCalendarIds((prev) => new Set(prev).add(calendarId));
    try {
      await mutate(
        () =>
          apiFetch(`${API_BASE}/api/calendars/${encodeURIComponent(calendarId)}`, jsonRequest("PUT", { workingDays: updated })),
        "Failed to update calendar",
      );
    } finally {
      setSavingCalendarIds((prev) => {
        const next = new Set(prev);
        next.delete(calendarId);
        return next;
      });
    }
  }

  function deleteCalendar(id: string) {
    return mutate(
      () => apiFetch(`${API_BASE}/api/calendars/${encodeURIComponent(id)}`, { method: "DELETE" }),
      "Failed to remove calendar",
    );
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
              <button onClick={() => void deletePattern(p.id)} style={{ ...secondaryButtonStyle, color: "#d03b3b", borderColor: "#d03b3b" }}>
                Remove pattern
              </button>
            </div>
            {p.shifts.map((s) => (
              <div key={s.id} style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 13, padding: "6px 0", borderTop: "1px solid #f0efeb" }}>
                <span style={{ fontWeight: 600 }}>{s.name}</span>
                <span style={{ color: "#898781" }}>{s.startTime} → {s.endTime}</span>
                <button onClick={() => void removeShift(s.id)} style={{ ...secondaryButtonStyle, marginLeft: "auto", padding: "3px 8px", fontSize: 11 }}>
                  Remove
                </button>
              </div>
            ))}
            {addingShiftFor === p.id ? (
              <form onSubmit={(e) => void addShift(p.id, e)} style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "flex-end" }}>
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
                checked={newCalendarDays[i] ?? false}
                onChange={(e) => setNewCalendarDays((d) => d.map((v, idx) => (idx === i ? e.target.checked : v)))}
              />
            </label>
          ))}
          <button type="submit" style={buttonStyle}>Create calendar</button>
        </form>

        {calendars.map((c) => {
          const saving = savingCalendarIds.has(c.id);
          return (
            <div key={c.id} style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 12, marginTop: 8, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ fontWeight: 600, minWidth: 140 }}>{c.name}</div>
              {DAY_LABELS.map((label, i) => (
                <label key={i} style={{ fontSize: 11, display: "flex", flexDirection: "column", alignItems: "center", opacity: saving ? 0.5 : 1 }}>
                  {label}
                  <input
                    type="checkbox"
                    checked={c.workingDays[i] ?? false}
                    disabled={saving}
                    onChange={() => void toggleCalendarDay(c.id, i)}
                  />
                </label>
              ))}
              {saving && <span style={{ fontSize: 11, color: "#898781" }}>Saving…</span>}
              <button onClick={() => void deleteCalendar(c.id)} style={{ ...secondaryButtonStyle, marginLeft: "auto", color: "#d03b3b", borderColor: "#d03b3b" }}>
                Remove
              </button>
            </div>
          );
        })}
      </section>
    </div>
  );
}
