import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";

interface WorkInstruction {
  id: string;
  partName: string;
  version: number;
  content: string;
  pdfUrl: string | null;
  isCurrent: boolean;
  createdByEmail: string | null;
  createdAt: string;
}

interface InstructionView {
  id: string;
  partName: string;
  version: number;
  orderNumber: string | null;
  viewedByEmail: string | null;
  viewedAt: string;
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

export default function WorkInstructionsPanel() {
  const { auth, logout } = useAuth();
  const [instructions, setInstructions] = useState<WorkInstruction[]>([]);
  const [views, setViews] = useState<InstructionView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ partName: "", content: "", pdfUrl: "" });
  const [submitting, setSubmitting] = useState(false);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<WorkInstruction[]>([]);

  const isAdmin = auth?.role === "admin" || auth?.role === "manager";
  const canSeeLog = isAdmin || auth?.role === "supervisor";

  function load() {
    fetch(`${API_BASE}/api/work-instructions`, { headers: { Authorization: `Bearer ${auth?.token}` } })
      .then((res) => {
        if (res.status === 401) {
          logout();
          throw new Error("session expired — please sign in again");
        }
        return res.json();
      })
      .then(setInstructions)
      .catch((err) => setError(String(err)));

    if (canSeeLog) {
      fetch(`${API_BASE}/api/work-instructions/views/log`, { headers: { Authorization: `Bearer ${auth?.token}` } })
        .then((res) => (res.ok ? res.json() : []))
        .then(setViews);
    }
  }

  useEffect(load, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/work-instructions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify({
          partName: form.partName.trim(),
          content: form.content.trim(),
          pdfUrl: form.pdfUrl.trim() || undefined,
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
      setForm({ partName: "", content: "", pdfUrl: "" });
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function showHistory(partName: string) {
    setHistoryFor(partName);
    const res = await fetch(`${API_BASE}/api/work-instructions/${encodeURIComponent(partName)}/versions`, {
      headers: { Authorization: `Bearer ${auth?.token}` },
    });
    if (res.ok) setHistory(await res.json());
  }

  if (!isAdmin) return null;

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Work instructions</h2>

      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
        <label style={{ fontSize: 12 }}>
          Part name<br />
          <input required value={form.partName} onChange={(e) => setForm((f) => ({ ...f, partName: e.target.value }))} placeholder="Bracket 12" style={inputStyle} />
        </label>
        <label style={{ fontSize: 12, flex: "1 1 300px" }}>
          Instructions<br />
          <textarea
            required
            value={form.content}
            onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
            rows={4}
            style={{ ...inputStyle, width: "100%", fontFamily: "inherit" }}
          />
        </label>
        <label style={{ fontSize: 12 }}>
          PDF link (optional)<br />
          <input value={form.pdfUrl} onChange={(e) => setForm((f) => ({ ...f, pdfUrl: e.target.value }))} placeholder="https://…" style={inputStyle} />
        </label>
        <button type="submit" disabled={submitting} style={buttonStyle}>
          {submitting ? "Publishing…" : "Publish new version"}
        </button>
      </form>

      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}
      {instructions.length === 0 && <p style={{ color: "#898781" }}>No work instructions yet.</p>}

      {instructions.map((wi) => (
        <div key={wi.id} style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 12, marginTop: 8 }}>
          <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
            <div><div style={{ fontSize: 12, color: "#898781" }}>Part</div><div style={{ fontWeight: 600 }}>{wi.partName}</div></div>
            <div><div style={{ fontSize: 12, color: "#898781" }}>Version</div><div>v{wi.version}</div></div>
            <div><div style={{ fontSize: 12, color: "#898781" }}>By</div><div>{wi.createdByEmail ?? "—"}</div></div>
            <button style={{ ...secondaryButtonStyle, marginLeft: "auto" }} onClick={() => showHistory(wi.partName)}>
              History
            </button>
          </div>
          <div style={{ fontSize: 13, marginTop: 8, whiteSpace: "pre-wrap" }}>{wi.content}</div>
          {wi.pdfUrl && (
            <a href={wi.pdfUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
              📄 Linked document
            </a>
          )}
        </div>
      ))}

      {historyFor && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 14 }}>Version history — {historyFor}</h3>
          {history.map((h) => (
            <div key={h.id} style={{ fontSize: 12, color: "#898781", padding: "4px 0", borderTop: "1px solid #e1e0d9" }}>
              v{h.version} — {h.createdByEmail ?? "—"} — {new Date(h.createdAt).toLocaleString()} {h.isCurrent && "(current)"}
            </div>
          ))}
        </div>
      )}

      {canSeeLog && views.length > 0 && (
        <details style={{ marginTop: 24 }}>
          <summary style={{ fontSize: 13, color: "#898781", cursor: "pointer" }}>View log ({views.length})</summary>
          {views.map((v) => (
            <div key={v.id} style={{ fontSize: 12, color: "#898781", padding: "4px 0", borderTop: "1px solid #e1e0d9" }}>
              {v.partName} v{v.version} shown to {v.viewedByEmail ?? "—"}
              {v.orderNumber ? ` for ${v.orderNumber}` : ""} at {new Date(v.viewedAt).toLocaleString()}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}