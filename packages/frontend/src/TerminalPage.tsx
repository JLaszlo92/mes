import { useEffect, useRef, useState } from "react";
import { useAuth } from "./auth-context.js";
import LoginForm from "./LoginForm.js";
import { apiFetch, API_BASE } from "./api.js";
import InstructionViewer, { VIEWER_LABELS_HU, type ViewerTab } from "./InstructionViewer.js";
import type { WorkInstruction } from "./work-instructions.js";

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

interface WorkOrderProgress {
  goodCount: number;
  scrapCount: number;
  quantity: number;
  remaining: number;
  targetReached: boolean;
}

interface ShiftSummary {
  shiftName: string;
  goodCount: number;
  scrapCount: number;
  availability: number;
  oee: number | null;
}

const HISTORICAL_STATUSES = new Set(["completed", "cancelled"]);

const startButtonStyle = {
  padding: "10px 20px",
  border: "1px solid #0b0b0b",
  borderRadius: 8,
  background: "#0b0b0b",
  color: "#fff",
  cursor: "pointer",
  fontSize: 16,
};

const instructionButtonStyle = {
  padding: "12px 18px",
  border: "1px solid #2c5a85",
  borderRadius: 8,
  background: "#e4ecf4",
  color: "#234a6e",
  cursor: "pointer",
  fontSize: 16,
  fontWeight: 600,
  minHeight: 48,
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
  // The instruction of each started work order (the one set on the order, else the one named like the part).
  const [instructionByOrder, setInstructionByOrder] = useState<Record<string, WorkInstruction>>({});
  const [viewer, setViewer] = useState<{ instruction: WorkInstruction; workOrderId: string; orderNumber: string; tab: ViewerTab } | null>(null);
  const [progressByWorkOrder, setProgressByWorkOrder] = useState<Record<string, WorkOrderProgress>>({});
  const [shiftSummaryByMachine, setShiftSummaryByMachine] = useState<Record<string, ShiftSummary>>({});
  const [showHistoryFor, setShowHistoryFor] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loggedViewsRef = useRef<Set<string>>(new Set());

  function load() {
    apiFetch(`${API_BASE}/api/terminal-uis/${encodeURIComponent(terminalUiId)}`)
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
              apiFetch(`${API_BASE}/api/work-order-assignments?machineId=${encodeURIComponent(machineId)}`)
                .then((r) => r.json())
                .then((assignments: Assignment[]) => [machineId, assignments] as const),
            ),
          ),
          Promise.all(
            data.machineIds.map((machineId) =>
              apiFetch(`${API_BASE}/api/fault-codes?machineId=${encodeURIComponent(machineId)}`)
                .then((r) => r.json())
                .then((codes: FaultCode[]) => [machineId, codes] as const),
            ),
          ),
          auth
            ? apiFetch(`${API_BASE}/api/fault-reports`, { headers: { Authorization: `Bearer ${auth.token}` } }).then((r) =>
                r.ok ? r.json() : [],
              )
            : Promise.resolve([]),
          Promise.all(
            data.machineIds.map((machineId) =>
              apiFetch(`${API_BASE}/api/machines/${encodeURIComponent(machineId)}/current-shift`)
                .then((r) => (r.ok ? r.json() : null))
                .then((summary: ShiftSummary | null) => [machineId, summary] as const),
            ),
          ),
        ]);
      })
      .then(([assignmentPairs, faultCodePairs, reports, shiftPairs]) => {
        const byMachine: Record<string, Assignment[]> = {};
        for (const [machineId, assignments] of assignmentPairs) byMachine[machineId] = assignments;
        setAssignmentsByMachine(byMachine);

        const codesByMachine: Record<string, FaultCode[]> = {};
        for (const [machineId, codes] of faultCodePairs) codesByMachine[machineId] = codes.filter((c) => c.isActive);
        setFaultCodesByMachine(codesByMachine);

        setRecentReports(reports as FaultReport[]);

        const shiftByMachine: Record<string, ShiftSummary> = {};
        for (const [machineId, summary] of shiftPairs) {
          if (summary) shiftByMachine[machineId] = summary;
        }
        setShiftSummaryByMachine(shiftByMachine);

        const inProgressOrderIds = Object.values(byMachine)
          .flat()
          .filter((a) => a.workOrderStatus === "in_progress")
          .map((a) => a.workOrderId);

        // Asked on every refresh, so a new version published in the dashboard
        // reaches the terminal within seconds. An order without instruction answers 404.
        Promise.all(
          [...new Set(inProgressOrderIds)].map((workOrderId) =>
            apiFetch(`${API_BASE}/api/work-orders/${encodeURIComponent(workOrderId)}/work-instruction`)
              .then((res) => (res.ok ? res.json() : null))
              .catch(() => null)
              .then((instruction: WorkInstruction | null) => [workOrderId, instruction] as const),
          ),
        ).then((pairs) => {
          const next: Record<string, WorkInstruction> = {};
          for (const [id, instruction] of pairs) {
            if (instruction) next[id] = instruction;
          }
          setInstructionByOrder(next);
        });

        if (inProgressOrderIds.length > 0 && auth) {
          Promise.all(
            inProgressOrderIds.map((workOrderId) =>
              apiFetch(`${API_BASE}/api/work-orders/${encodeURIComponent(workOrderId)}/progress`, {
                headers: { Authorization: `Bearer ${auth.token}` },
              })
                .then((res) => (res.ok ? res.json() : null))
                .then((progress) => [workOrderId, progress] as const),
            ),
          ).then((pairs) => {
            const next: Record<string, WorkOrderProgress> = {};
            for (const [id, progress] of pairs) {
              if (progress) next[id] = progress;
            }
            setProgressByWorkOrder(next);
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

  if (!auth) {
    return <LoginForm />;
  }

  /**
   * Opens the instruction of a started order. This is the moment that is
   * logged as "shown to the operator": once per version and order in a session.
   */
  function openInstruction(instruction: WorkInstruction, workOrderId: string, orderNumber: string, tab: ViewerTab) {
    setViewer({ instruction, workOrderId, orderNumber, tab });
    const key = `${instruction.id}:${workOrderId}`;
    if (loggedViewsRef.current.has(key)) return;
    loggedViewsRef.current.add(key);
    apiFetch(`${API_BASE}/api/work-instructions/view`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workInstructionId: instruction.id, workOrderId }),
    })
      .then((res) => {
        if (!res.ok) loggedViewsRef.current.delete(key);
      })
      .catch(() => {
        // Not recorded (network): the next opening tries again.
        loggedViewsRef.current.delete(key);
      });
  }

  async function startWorkOrder(workOrderId: string) {
    await apiFetch(`${API_BASE}/api/work-orders/${encodeURIComponent(workOrderId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth!.token}` },
      body: JSON.stringify({ status: "in_progress" }),
    });
    load();
  }

  async function completeWorkOrder(workOrderId: string) {
    await apiFetch(`${API_BASE}/api/work-orders/${encodeURIComponent(workOrderId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth!.token}` },
      body: JSON.stringify({ status: "completed" }),
    });
    load();
  }

  async function reportFault(machineId: string, faultCodeId: string, faultLabel: string) {
    const res = await apiFetch(`${API_BASE}/api/fault-reports`, {
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
        const shiftSummary = shiftSummaryByMachine[machineId];

        const currentAssignments = assignments.filter((a) => !HISTORICAL_STATUSES.has(a.workOrderStatus));
        const historicalAssignments = assignments.filter((a) => HISTORICAL_STATUSES.has(a.workOrderStatus));
        const showHistory = showHistoryFor[machineId] ?? false;

        return (
          <section key={machineId} style={{ marginTop: 24, border: "1px solid #e1e0d9", borderRadius: 12, padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
              <h2 style={{ fontSize: 18, marginTop: 0 }}>{ui.machineNames[i]}</h2>
              {shiftSummary && (
                <div style={{ display: "flex", gap: 14, fontSize: 13, color: "#898781" }}>
                  <span>Shift: <strong style={{ color: "#0b0b0b" }}>{shiftSummary.shiftName}</strong></span>
                  <span>Good: <strong style={{ color: "#0ca30c" }}>{shiftSummary.goodCount}</strong></span>
                  <span>Scrap: <strong style={{ color: "#d03b3b" }}>{shiftSummary.scrapCount}</strong></span>
                  <span>OEE: <strong style={{ color: "#0b0b0b" }}>{shiftSummary.oee !== null ? `${Math.round(shiftSummary.oee * 100)}%` : "—"}</strong></span>
                </div>
              )}
            </div>

            {currentAssignments.length === 0 && historicalAssignments.length === 0 && (
              <p style={{ color: "#898781" }}>No work orders scheduled.</p>
            )}

            {currentAssignments.map((a) => {
              const instruction = a.workOrderStatus === "in_progress" ? instructionByOrder[a.workOrderId] : undefined;
              const progress = progressByWorkOrder[a.workOrderId];
              return (
                <div key={a.id} style={{ padding: "12px 0", borderTop: "1px solid #e1e0d9" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 16 }}>{a.orderNumber} — {a.partName}</div>
                      <div style={{ fontSize: 13, color: "#898781" }}>
                        {a.quantity} db · {new Date(a.plannedStart).toLocaleString()} → {new Date(a.plannedEnd).toLocaleString()}
                      </div>
                      {a.workOrderStatus === "in_progress" && progress && (
                        <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4, color: progress.targetReached ? "#0ca30c" : "#0b0b0b" }}>
                          {progress.goodCount} / {progress.quantity} db kész
                          {progress.targetReached ? " — célmennyiség elérve" : ` — ${progress.remaining} hátra`}
                        </div>
                      )}
                    </div>
                    {a.workOrderStatus === "in_progress" ? (
                      <button
                        style={{ ...startButtonStyle, background: "#0ca30c", borderColor: "#0ca30c" }}
                        onClick={() => completeWorkOrder(a.workOrderId)}
                      >
                        Befejezés
                      </button>
                    ) : (
                      <button style={startButtonStyle} onClick={() => startWorkOrder(a.workOrderId)}>
                        Elkezdés
                      </button>
                    )}
                  </div>

                  {instruction && (
                    <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <button style={instructionButtonStyle} onClick={() => openInstruction(instruction, a.workOrderId, a.orderNumber, "text")}>
                        Munkautasítás
                      </button>
                      {instruction.pdfFileId && (
                        <button style={instructionButtonStyle} onClick={() => openInstruction(instruction, a.workOrderId, a.orderNumber, "pdf")}>
                          PDF megnyitása
                        </button>
                      )}
                      <span style={{ fontSize: 13, color: "#898781" }}>
                        {instruction.partName} · v{instruction.version}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}

            {historicalAssignments.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <button
                  onClick={() => setShowHistoryFor((prev) => ({ ...prev, [machineId]: !showHistory }))}
                  style={{ fontSize: 12, padding: "4px 10px", border: "1px solid #e1e0d9", borderRadius: 6, background: "#fff", cursor: "pointer", color: "#898781" }}
                >
                  {showHistory ? "Hide" : "Show"} history ({historicalAssignments.length})
                </button>

                {showHistory &&
                  historicalAssignments.map((a) => (
                    <div key={a.id} style={{ padding: "12px 0", borderTop: "1px solid #e1e0d9", opacity: 0.7 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 15 }}>{a.orderNumber} — {a.partName}</div>
                          <div style={{ fontSize: 13, color: "#898781" }}>
                            {a.quantity} db · {new Date(a.plannedStart).toLocaleString()} → {new Date(a.plannedEnd).toLocaleString()}
                          </div>
                        </div>
                        <span style={{ color: "#898781", fontSize: 13 }}>{a.workOrderStatus === "completed" ? "Kész" : "Törölve"}</span>
                      </div>
                    </div>
                  ))}
              </div>
            )}

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

      {viewer && (
        <InstructionViewer
          key={`${viewer.instruction.id}:${viewer.workOrderId}`}
          instruction={viewer.instruction}
          subtitle={viewer.orderNumber}
          initialTab={viewer.tab}
          labels={VIEWER_LABELS_HU}
          large
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}
