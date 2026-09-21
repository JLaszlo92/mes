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
}

interface FaultReport {
  id: string;
  machineId: string;
  machineName: string;
  faultCode: string;
  faultName: string;
  occurrenceCount: number;
  comment: string | null;
  status: "pending" | "confirmed" | "modified" | "rejected";
  reportedByEmail: string | null;
  reportedAt: string;
  reviewedByEmail: string | null;
  reviewerNote: string | null;
}

interface CorrectiveAction {
  id: string;
  faultReportId: string;
  description: string;
  performedByEmail: string | null;
  performedAt: string;
  signedOffByEmail: string | null;
  signedOffAt: string | null;
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
  pending: "#eda100",
  confirmed: "#0ca30c",
  modified: "#185fa5",
  rejected: "#d03b3b",
};

export default function FaultReportsPanel() {
  const { auth, logout } = useAuth();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [faultCodes, setFaultCodes] = useState<FaultCode[]>([]);
  const [reports, setReports] = useState<FaultReport[]>([]);
  const [correctiveActions, setCorrectiveActions] = useState<CorrectiveAction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ machineId: "", faultCodeId: "", occurrenceCount: "1", comment: "" });
  const [submitting, setSubmitting] = useState(false);
  const [actionDrafts, setActionDrafts] = useState<Record<string, string>>({});

  const canReview = auth?.role === "manager" || auth?.role === "admin";
  const canSignOff = auth?.role === "supervisor" || auth?.role === "manager" || auth?.role === "admin";
  const canCreateTicket =
    auth?.role === "supervisor" || auth?.role === "maintenance" || auth?.role === "manager" || auth?.role === "admin";

  function load() {
    Promise.all([
      fetch(`${API_BASE}/api/machine-registry`).then((r) => r.json()),
      fetch(`${API_BASE}/api/fault-codes`).then((r) => r.json()),
      fetch(`${API_BASE}/api/fault-reports`, { headers: { Authorization: `Bearer ${auth?.token}` } }).then((res) => {
        if (res.status === 401) {
          logout();
          throw new Error("session expired — please sign in again");
        }
        return res.json();
      }),
      fetch(`${API_BASE}/api/corrective-actions`, { headers: { Authorization: `Bearer ${auth?.token}` } }).then(
        (res) => {
          if (res.status === 401) {
            logout();
            throw new Error("session expired — please sign in again");
          }
          return res.json();
        },
      ),
    ])
      .then(([m, fc, fr, ca]) => {
        setMachines(m);
        setFaultCodes(fc);
        setReports(fr);
        setCorrectiveActions(ca);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }

  useEffect(load, []);

  const availableCodes = faultCodes.filter((f) => f.machineId === form.machineId);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/fault-reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify({
          machineId: form.machineId,
          faultCodeId: form.faultCodeId,
          occurrenceCount: Number(form.occurrenceCount) || 1,
          comment: form.comment.trim() || undefined,
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
      setForm({ machineId: "", faultCodeId: "", occurrenceCount: "1", comment: "" });
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function review(id: string, status: "confirmed" | "modified" | "rejected", adjustedCount?: number) {
    const res = await fetch(`${API_BASE}/api/fault-reports/${encodeURIComponent(id)}/review`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
      body: JSON.stringify({ status, adjustedCount }),
    });
    if (res.status === 401) {
      logout();
      return;
    }
    load();
  }

  async function createMaintenanceTicket(r: FaultReport) {
    const res = await fetch(`${API_BASE}/api/maintenance-work-orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
      body: JSON.stringify({
        machineId: r.machineId,
        title: `${r.faultCode} — ${r.faultName}`,
        description: r.comment ?? undefined,
        sourceType: "fault_report",
        sourceId: r.id,
      }),
    });
    if (res.status === 401) {
      logout();
    }
  }

  async function addCorrectiveAction(faultReportId: string) {
    const description = (actionDrafts[faultReportId] ?? "").trim();
    if (!description) return;
    const res = await fetch(`${API_BASE}/api/corrective-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
      body: JSON.stringify({ faultReportId, description }),
    });
    if (res.status === 401) {
      logout();
      return;
    }
    setActionDrafts((prev) => ({ ...prev, [faultReportId]: "" }));
    load();
  }

  async function signOff(actionId: string) {
    const res = await fetch(`${API_BASE}/api/corrective-actions/${encodeURIComponent(actionId)}/sign-off`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${auth?.token}` },
    });
    if (res.status === 401) {
      logout();
      return;
    }
    load();
  }

  const pending = reports.filter((r) => r.status === "pending");
  const reviewed = reports.filter((r) => r.status !== "pending");

  function renderCorrectiveActions(reportId: string) {
    const actions = correctiveActions.filter((a) => a.faultReportId === reportId);
    return (
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #e1e0d9" }}>
        <div style={{ fontSize: 11, color: "#898781", marginBottom: 6 }}>Corrective actions</div>
        {actions.map((a) => (
          <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 4 }}>
            <div style={{ flex: 1 }}>
              {a.description}
              <span style={{ color: "#898781" }}> — {a.performedByEmail ?? "—"}, {new Date(a.performedAt).toLocaleString()}</span>
            </div>
            {a.signedOffAt ? (
              <span style={{ color: "#0ca30c" }}>✓ signed off by {a.signedOffByEmail}</span>
            ) : canSignOff ? (
              <button style={{ ...secondaryButtonStyle, padding: "3px 8px", fontSize: 11 }} onClick={() => signOff(a.id)}>
                Sign off
              </button>
            ) : (
              <span style={{ color: "#eda100" }}>pending sign-off</span>
            )}
          </div>
        ))}
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <input
            placeholder="What was done about it…"
            value={actionDrafts[reportId] ?? ""}
            onChange={(e) => setActionDrafts((prev) => ({ ...prev, [reportId]: e.target.value }))}
            style={{ ...inputStyle, flex: 1, fontSize: 12 }}
          />
          <button style={{ ...secondaryButtonStyle, padding: "4px 10px", fontSize: 12 }} onClick={() => addCorrectiveAction(reportId)}>
            Log action
          </button>
        </div>
      </div>
    );
  }

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Fault reports</h2>

      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
        <label style={{ fontSize: 12 }}>
          Machine<br />
          <select required value={form.machineId} onChange={(e) => setForm((f) => ({ ...f, machineId: e.target.value, faultCodeId: "" }))} style={inputStyle}>
            <option value="" disabled>select…</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>
          Fault code<br />
          <select required value={form.faultCodeId} onChange={(e) => setForm((f) => ({ ...f, faultCodeId: e.target.value }))} style={inputStyle} disabled={!form.machineId}>
            <option value="" disabled>select…</option>
            {availableCodes.map((fc) => (
              <option key={fc.id} value={fc.id}>{fc.code} — {fc.name}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>
          Count<br />
          <input type="number" min="1" value={form.occurrenceCount} onChange={(e) => setForm((f) => ({ ...f, occurrenceCount: e.target.value }))} style={{ ...inputStyle, width: 70 }} />
        </label>
        <label style={{ fontSize: 12, flex: "1 1 200px" }}>
          Comment<br />
          <input value={form.comment} onChange={(e) => setForm((f) => ({ ...f, comment: e.target.value }))} style={{ ...inputStyle, width: "100%" }} />
        </label>
        <button type="submit" disabled={submitting} style={buttonStyle}>
          {submitting ? "Reporting…" : "Report"}
        </button>
      </form>

      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}
      {pending.length === 0 && <p style={{ color: "#898781" }}>No pending fault reports.</p>}

      {pending.map((r) => (
        <div key={r.id} style={{ border: "1px solid #eda100", borderRadius: 10, padding: 12, marginTop: 8 }}>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>
                {r.machineName} — {r.faultCode} ({r.faultName}) × {r.occurrenceCount}
              </div>
              {r.comment && <div style={{ fontSize: 13 }}>{r.comment}</div>}
              <div style={{ fontSize: 11, color: "#898781" }}>
                {r.reportedByEmail ?? "—"} · {new Date(r.reportedAt).toLocaleString()}
              </div>
            </div>
            {canReview && (
              <div style={{ display: "flex", gap: 6 }}>
                <button style={secondaryButtonStyle} onClick={() => review(r.id, "confirmed")}>
                  Confirm
                </button>
                <button
                  style={secondaryButtonStyle}
                  onClick={() => {
                    const adjusted = window.prompt("Adjusted count:", String(r.occurrenceCount));
                    if (adjusted !== null) review(r.id, "modified", Number(adjusted));
                  }}
                >
                  Modify
                </button>
                <button style={{ ...secondaryButtonStyle, color: "#d03b3b", borderColor: "#d03b3b" }} onClick={() => review(r.id, "rejected")}>
                  Reject
                </button>
              </div>
            )}
          </div>
          {renderCorrectiveActions(r.id)}
        </div>
      ))}

      {reviewed.length > 0 && (
        <details style={{ marginTop: 16 }} open>
          <summary style={{ fontSize: 13, color: "#898781", cursor: "pointer" }}>{reviewed.length} reviewed</summary>
          {reviewed.map((r) => (
            <div key={r.id} style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 12, marginTop: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 600 }}>
                  {r.machineName} — {r.faultCode} × {r.occurrenceCount}{" "}
                  <span style={{ color: STATUS_COLOR[r.status], fontSize: 11 }}>{r.status}</span>
                </div>
                {canCreateTicket && r.status === "confirmed" && (
                  <button style={secondaryButtonStyle} onClick={() => createMaintenanceTicket(r)}>
                    Create ticket
                  </button>
                )}
              </div>
              <div style={{ fontSize: 11, color: "#898781" }}>reviewed by {r.reviewedByEmail ?? "—"}</div>
              {r.status !== "rejected" && renderCorrectiveActions(r.id)}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}