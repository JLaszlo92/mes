import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE } from "./api.js";
import { useScope } from "./scope.js";

interface Alert {
  id: string;
  /** Rendszerriasztásnál (pl. sikertelen mentés) null — ilyenkor machineName "System". */
  machineId: string | null;
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
  isActive: boolean;
}

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

/** A backend hibaüzenete, vagy egy általános üzenet, ha a válasz nem JSON. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `${fallback} (${res.status})`;
}

export default function AlertsPanel() {
  const { isInScope } = useScope();
  const { auth } = useAuth();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Riasztások, amelyekhez ebben a munkamenetben már készült munkarendelés — a gomb ne duplikáljon. */
  const [ticketCreatedFor, setTicketCreatedFor] = useState<Set<string>>(new Set());
  const [creatingTicketFor, setCreatingTicketFor] = useState<string | null>(null);
  const [form, setForm] = useState({
    type: "machine_down" as "machine_down" | "scrap_rate",
    machineId: "",
    threshold: "",
    notifyRoles: ["supervisor", "manager"] as string[],
  });
  const [submitting, setSubmitting] = useState(false);

  const isAdmin = auth?.role === "admin" || auth?.role === "manager";
  const canCreateTicket =
    auth?.role === "supervisor" || auth?.role === "maintenance" || auth?.role === "manager" || auth?.role === "admin";

  // A token hozzáadását és a 401-es kiléptetést az apiFetch végzi.
  function load() {
    const getJson = <T,>(path: string) =>
      apiFetch(`${API_BASE}${path}`).then((r) =>
        r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(`${path}: ${r.status}`)),
      );
    const calls: Promise<void>[] = [
      getJson<Alert[]>("/api/alerts").then(setAlerts),
      getJson<Machine[]>("/api/machine-registry").then(setMachines),
    ];
    if (isAdmin) calls.push(getJson<AlertRule[]>("/api/alert-rules").then(setRules));
    Promise.all(calls).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function acknowledge(id: string) {
    setError(null);
    const res = await apiFetch(`${API_BASE}/api/alerts/${encodeURIComponent(id)}/acknowledge`, { method: "POST" });
    if (!res.ok) setError(await errorMessage(res, "Failed to acknowledge alert"));
    load();
  }

  /**
   * Karbantartási munkarendelés egy gépriasztásból. Korábban a választ nem
   * nézte: nem derült ki, sikerült-e, és többszöri kattintás több azonos
   * munkarendelést hozott létre.
   */
  async function createMaintenanceTicket(alert: Alert) {
    if (!alert.machineId || creatingTicketFor) return;
    setError(null);
    setNotice(null);
    setCreatingTicketFor(alert.id);
    try {
      const res = await apiFetch(`${API_BASE}/api/maintenance-work-orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machineId: alert.machineId,
          title: `Investigate: ${alert.message}`,
          sourceType: "alert",
          sourceId: alert.id,
        }),
      });
      if (res.ok) {
        setTicketCreatedFor((prev) => new Set(prev).add(alert.id));
        setNotice(`Maintenance work order created for ${alert.machineName}.`);
      } else {
        setError(await errorMessage(res, "Failed to create maintenance work order"));
      }
    } finally {
      setCreatingTicketFor(null);
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
      const res = await apiFetch(`${API_BASE}/api/alert-rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: form.type,
          machineId: form.machineId || undefined,
          threshold: Number(form.threshold),
          notifyRoles: form.notifyRoles,
        }),
      });
      if (!res.ok) {
        setError(await errorMessage(res, "Failed to add rule"));
        return;
      }
      setForm({ type: "machine_down", machineId: "", threshold: "", notifyRoles: ["supervisor", "manager"] });
      load();
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleRuleActive(rule: AlertRule) {
    const res = await apiFetch(`${API_BASE}/api/alert-rules/${encodeURIComponent(rule.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !rule.isActive }),
    });
    if (!res.ok) setError(await errorMessage(res, "Failed to update rule"));
    load();
  }

  async function removeRule(id: string) {
    const res = await apiFetch(`${API_BASE}/api/alert-rules/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) setError(await errorMessage(res, "Failed to remove rule"));
    load();
  }

  const openAlerts = alerts.filter((a) => !a.resolvedAt && isInScope(a.machineId));
  const machineName = (id: string) => machines.find((m) => m.id === id)?.name ?? id;

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Alerts</h2>

      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}
      {notice && <p style={{ color: "#0ca30c", fontSize: 13 }}>{notice}</p>}
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
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {/* Munkarendelés csak gépriasztásból — rendszerriasztásnak (machineId null) nincs gépe. */}
            {canCreateTicket && a.type === "machine_down" && a.machineId !== null &&
              (ticketCreatedFor.has(a.id) ? (
                <span style={{ fontSize: 12, color: "#0ca30c" }}>Ticket created</span>
              ) : (
                <button
                  style={secondaryButtonStyle}
                  disabled={creatingTicketFor !== null}
                  onClick={() => void createMaintenanceTicket(a)}
                >
                  {creatingTicketFor === a.id ? "Creating…" : "Create ticket"}
                </button>
              ))}
            {a.acknowledgedAt ? (
              <span style={{ fontSize: 12, color: "#898781" }}>Acknowledged</span>
            ) : (
              <button style={secondaryButtonStyle} onClick={() => void acknowledge(a.id)}>
                Acknowledge
              </button>
            )}
          </div>
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
                {machines.filter((m) => m.isActive).map((m) => (
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
                <button type="button" onClick={() => void toggleRuleActive(r)} style={secondaryButtonStyle}>
                  {r.isActive ? "Disable" : "Enable"}
                </button>
                <button type="button" onClick={() => void removeRule(r.id)} style={{ ...secondaryButtonStyle, color: "#d03b3b", borderColor: "#d03b3b" }}>
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
