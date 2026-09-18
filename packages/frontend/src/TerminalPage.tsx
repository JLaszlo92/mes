import { useEffect, useRef, useState } from "react";
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

interface FaultCode {
  id: string;
  machineId: string;
  code: string;
  name: string;
  isActive: boolean;
}

interface FaultReport {
  id: string;
  machineId: string;
  faultCode: string;
  status: string;
}

interface WorkInstruction {
  id: string;
  partName: string;
  version: number;
  content: string;
  pdfUrl: string | null;
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

const faultButtonStyle = {
  padding: "14px 18px",
  border: "1px solid #d03b3b",
  borderRadius: 10,
  background: "#fff",
  color: "#d03b3b",
  cursor: "pointer",
  fontSize: 15,
  fontWeight: 600,
  minWidth: 120,
  textAlign: "center" as const,
};

export default function TerminalPage({ terminalUiId }: { terminalUiId: string }) {
  const { auth, logout } = useAuth();
  const [ui, setUi] = useState<TerminalUi | null>(null);
  const [assignmentsByMachine, setAssignmentsByMachine] = useState<Record<string, Assignment[]>>({});
  const [faultCodesByMachine, setFaultCodesByMachine] = useState<Record<string, FaultCode[]>>({});
  const [recentReports, setRecentReports] = useState<FaultReport[]>([]);
  const [instructionsByPart, setInstructionsByPart] = useState<Record<string, WorkInstruction | null>>({});
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Melyik (instructionId, workOrderId) párokat naplóztuk már megtekintésként
  // — enélkül minden 5 másodperces frissítés újra naplózna.
  const loggedViewsRef = useRef<Set<string>>(new Set());

  function load() {
    fetch(`${API_BASE}/api/terminal-uis/${encodeURIComponent(terminalUiId)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`terminal UI not found (${res.status})`);
        return res.json();
      })
      .then((data: TerminalUi) => {
        setUi(data);
        setError(null);
        return Promise.all([
          Promise.all(
            data.machineIds.map((machineId) =>
              fetch(`${API_BASE}/api/work-order-assignments?machineId=${encodeURIComponent(machineId)}`)
                .then((r) => r.json())
                .then((assignments: Assignment[]) => [machineId, assignments] as const),
            ),
          ),
          Promise.all(
            data.machineIds.map((machineId) =>
              fetch(`${API_BASE}/api/fault-codes?machineId=${encodeURIComponent(machineId)}`)
                .then((r) => r.json())
                .then((codes: FaultCode[]) => [machineId, codes] as const),
            ),
          ),
          auth
            ? fetch(`${API_BASE}/api/fault-reports`, { headers: { Authorization: `Bearer ${auth.token}` } }).then((r) =>
                r.ok ? r.json() : [],
              )
            : Promise.resolve([]),
        ]);
      })
      .then(([assignmentPairs, faultCodePairs, reports]) => {
        const byMachine: Record<string, Assignment[]> = {};
        for (const [machineId, assignments] of assignmentPairs) byMachine[machineId] = assignments;
        setAssignmentsByMachine(byMachine);

        const codesByMachine: Record<string, FaultCode[]> = {};
        for (const [machineId, codes] of faultCodePairs) codesByMachine[machineId] = codes.filter((c) => c.isActive);
        setFaultCodesByMachine(codesByMachine);

        setRecentReports(reports as FaultReport[]);

        // Az aktív (in_progress) munkarendelések alkatrészeihez lekérjük az
        // aktuális munkautasítást, és naplózzuk a megtekintést (egyszer).
        const activePartNames = new Set(
          Object.values(byMachine)
            .flat()
            .filter((a) => a.workOrderStatus === "in_progress")
            .map((a) => a.partName),
        );
        for (const partName of activePartNames) {
          if (partName in instructionsByPart) continue;
          fetch(`${API_BASE}/api/work-instructions/${encodeURIComponent(partName)}`, {
            headers: auth ? { Authorization: `Bearer ${auth.token}` } : {},
          })
            .then((res) => (res.ok ? res.json() : null))
            .then((instruction: WorkInstruction | null) => {
              setInstructionsByPart((prev) => ({ ...prev, [partName]: instruction }));
            });
        }
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

  // Ha egy aktív munkarendeléshez most töltődött be az utasítás, naplózzuk a
  // megtekintést — csak egyszer, (instructionId, workOrderId) párokként.
  useEffect(() => {
    if (!auth) return;
    for (const assignments of Object.values(assignmentsByMachine)) {
      for (const a of assignments) {
        if (a.workOrderStatus !== "in_progress") continue;
        const instruction = instructionsByPart[a.partName];
        if (!instruction) continue;
        const key = `${instruction.id}:${a.workOrderId}`;
        if (loggedViewsRef.current.has(key)) continue;
        loggedViewsRef.current.add(key);
        fetch(`${API_BASE}/api/work-instructions/view`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
          body: JSON.stringify({ workInstructionId: instruction.id, workOrderId: a.workOrderId }),
        }).catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignmentsByMachine, instructionsByPart]);

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

  async function completeWorkOrder(workOrderId: string) {
    await fetch(`${API_BASE}/api/work-orders/${encodeURIComponent(workOrderId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth!.token}` },
      body: JSON.stringify({ status: "completed" }),
    });
    load();
  }

  async function reportFault(machineId: string, faultCodeId: string, faultLabel: string) {
    const res = await fetch(`${API_BASE}/api/fault-reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth!.token}` },
      body: JSON.stringify({ machineId, faultCodeId, occurrenceCount: 1 }),
    });
    if (res.ok) {
      setFeedback(`Reported: ${faultLabel}`);
      setTimeout(() => setFeedback(null), 3000);
      load();
    }
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
      {feedback && (
        <p style={{ background: "#eafaea", color: "#0ca30c", padding: "8px 12px", borderRadius: 8, fontWeight: 600 }}>
          ✓ {feedback}
        </p>
      )}
      {!ui && !error && <p style={{ color: "#898781" }}>Loading…</p>}

      {ui?.machineIds.map((machineId, i) => {
        const assignments = assignmentsByMachine[machineId] ?? [];
        const faultCodes = faultCodesByMachine[machineId] ?? [];
        const machineRecentReports = recentReports.filter((r) => r.machineId === machineId).slice(0, 5);

        return (
          <section key={machineId} style={{ marginTop: 24, border: "1px solid #e1e0d9", borderRadius: 12, padding: 16 }}>
            <h2 style={{ fontSize: 18, marginTop: 0 }}>{ui.machineNames[i]}</h2>

            {assignments.length === 0 && <p style={{ color: "#898781" }}>No work orders scheduled.</p>}
            {assignments.map((a) => {
              const instruction = instructionsByPart[a.partName];
              return (
                <div key={a.id} style={{ padding: "12px 0", borderTop: "1px solid #e1e0d9" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 16 }}>{a.orderNumber} — {a.partName}</div>
                      <div style={{ fontSize: 13, color: "#898781" }}>
                        {a.quantity} db · {new Date(a.plannedStart).toLocaleString()} → {new Date(a.plannedEnd).toLocaleString()}
                      </div>
                    </div>
                    {a.workOrderStatus === "in_progress" ? (
                      <button
                        style={{ ...startButtonStyle, background: "#0ca30c", borderColor: "#0ca30c" }}
                        onClick={() => completeWorkOrder(a.workOrderId)}
                      >
                        Befejezés
                      </button>
                    ) : a.workOrderStatus === "completed" ? (
                      <span style={{ color: "#898781" }}>Kész</span>
                    ) : (
                      <button style={startButtonStyle} onClick={() => startWorkOrder(a.workOrderId)}>
                        Elkezdés
                      </button>
                    )}
                  </div>

                  {a.workOrderStatus === "in_progress" && instruction && (
                    <div style={{ marginTop: 10, background: "#f4f6fb", borderRadius: 8, padding: 12 }}>
                      <div style={{ fontSize: 11, color: "#898781", marginBottom: 4 }}>
                        📋 Work instructions — v{instruction.version}
                      </div>
                      <div style={{ fontSize: 14, whiteSpace: "pre-wrap" }}>{instruction.content}</div>
                      {instruction.pdfUrl && (
                        <a href={instruction.pdfUrl} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>
                          📄 Open linked document
                        </a>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {faultCodes.length > 0 && (
              <div style={{ marginTop: 16, borderTop: "1px solid #e1e0d9", paddingTop: 12 }}>
                <div style={{ fontSize: 13, color: "#898781", marginBottom: 8 }}>Report a fault</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {faultCodes.map((fc) => (
                    <button
                      key={fc.id}
                      style={faultButtonStyle}
                      onClick={() => reportFault(machineId, fc.id, `${fc.code} — ${fc.name}`)}
                    >
                      {fc.code}
                      <br />
                      <span style={{ fontWeight: 400, fontSize: 12 }}>{fc.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {machineRecentReports.length > 0 && (
              <div style={{ marginTop: 12, fontSize: 12, color: "#898781" }}>
                Recent: {machineRecentReports.map((r) => `${r.faultCode} (${r.status})`).join(", ")}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}