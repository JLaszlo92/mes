import { useEffect, useState } from "react";
import { useAuth } from "./auth-context.js";
import LoginForm from "./LoginForm.js";

interface TerminalUi {
  id: string;
  name: string;
  machineIds: string[];
  machineNames: string[];
}

interface Assignment {
  id: string;
  workOrderId: string;
  plannedStart: string;
  plannedEnd: string;
  orderNumber: string;
  partName: string;
  quantity: number;
  workOrderStatus: string;
}

const WS_URL = import.meta.env.VITE_BACKEND_WS_URL ?? "ws://localhost:3001/ws";
const API_BASE = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");

const startButtonStyle = {
  padding: "10px 20px",
  border: "1px solid #0b0b0b",
  borderRadius: 8,
  background: "#0b0b0b",
  color: "#fff",
  cursor: "pointer",
  fontSize: 16,
};

export default function TerminalPage({ terminalUiId }: { terminalUiId: string }) {
  const { auth, logout } = useAuth();
  const [ui, setUi] = useState<TerminalUi | null>(null);
  const [assignmentsByMachine, setAssignmentsByMachine] = useState<Record<string, Assignment[]>>({});
  const [error, setError] = useState<string | null>(null);

  function load() {
    fetch(`${API_BASE}/api/terminal-uis/${encodeURIComponent(terminalUiId)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`terminal UI not found (${res.status})`);
        return res.json();
      })
      .then((data: TerminalUi) => {
        setUi(data);
        setError(null);
        return Promise.all(
          data.machineIds.map((machineId) =>
            fetch(`${API_BASE}/api/work-order-assignments?machineId=${encodeURIComponent(machineId)}`)
              .then((r) => r.json())
              .then((assignments: Assignment[]) => [machineId, assignments] as const),
          ),
        );
      })
      .then((pairs) => {
        if (!pairs) return;
        const byMachine: Record<string, Assignment[]> = {};
        for (const [machineId, assignments] of pairs) byMachine[machineId] = assignments;
        setAssignmentsByMachine(byMachine);
      })
      .catch((err) => setError(String(err)));
  }

  useEffect(() => {
    if (!auth) return;
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, terminalUiId]);

  if (!auth) {
    return <LoginForm />;
  }

  async function startWorkOrder(workOrderId: string) {
    await fetch(`${API_BASE}/api/work-orders/${encodeURIComponent(workOrderId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth!.token}` },
      body: JSON.stringify({ status: "in_progress" }),
    });
    load();
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 900, margin: "20px auto", padding: "0 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ fontSize: 22 }}>{ui?.name ?? "Terminal"}</h1>
        <button onClick={logout} style={{ fontSize: 14, padding: "6px 12px", border: "1px solid #e1e0d9", borderRadius: 6, background: "#fff", cursor: "pointer" }}>
          Sign out
        </button>
      </header>

      {error && <p style={{ color: "#d03b3b" }}>{error}</p>}
      {!ui && !error && <p style={{ color: "#898781" }}>Loading…</p>}

      {ui?.machineIds.map((machineId, i) => {
        const assignments = assignmentsByMachine[machineId] ?? [];
        return (
          <section key={machineId} style={{ marginTop: 24, border: "1px solid #e1e0d9", borderRadius: 12, padding: 16 }}>
            <h2 style={{ fontSize: 18, marginTop: 0 }}>{ui.machineNames[i]}</h2>
            {assignments.length === 0 && <p style={{ color: "#898781" }}>No work orders scheduled.</p>}
            {assignments.map((a) => (
              <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 16, padding: "12px 0", borderTop: "1px solid #e1e0d9" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 16 }}>{a.orderNumber} — {a.partName}</div>
                  <div style={{ fontSize: 13, color: "#898781" }}>
                    {a.quantity} db · {new Date(a.plannedStart).toLocaleString()} → {new Date(a.plannedEnd).toLocaleString()}
                  </div>
                </div>
                {a.workOrderStatus === "in_progress" ? (
                  <span style={{ color: "#0ca30c", fontWeight: 600 }}>● Aktív</span>
                ) : a.workOrderStatus === "completed" ? (
                  <span style={{ color: "#898781" }}>Kész</span>
                ) : (
                  <button style={startButtonStyle} onClick={() => startWorkOrder(a.workOrderId)}>
                    Elkezdés
                  </button>
                )}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}