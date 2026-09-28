import { useEffect, useRef, useState } from "react";
import { useAuth } from "./auth-context.js";

interface Machine {
  id: string;
  name: string;
  calendarId: string | null;
  isActive: boolean;
}

interface Calendar {
  id: string;
  workingDays: boolean[];
}

interface Assignment {
  id: string;
  workOrderId: string;
  machineId: string;
  plannedStart: string;
  plannedEnd: string;
  orderNumber: string;
  partName: string;
  quantity: number;
}

interface WorkOrder {
  id: string;
  orderNumber: string;
  partName: string;
  quantity: number;
  expectedCycleTimeSeconds: number | null;
  status: string;
}

const WS_URL = import.meta.env.VITE_BACKEND_WS_URL ?? "ws://localhost:3001/ws";
const API_BASE = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");

const PX_PER_HOUR = 40;
const ROW_HEIGHT = 56;
const LABEL_WIDTH = 160;
const SNAP_MINUTES = 15;

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function snap(d: Date): Date {
  const ms = SNAP_MINUTES * 60 * 1000;
  return new Date(Math.round(d.getTime() / ms) * ms);
}

export default function GanttSchedulePanel() {
  const { auth, logout } = useAuth();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [daysToShow, setDaysToShow] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const windowStart = startOfDay(new Date());
  const totalHours = daysToShow * 24;
  const totalWidth = totalHours * PX_PER_HOUR;

  function load() {
    Promise.all([
      fetch(`${API_BASE}/api/machine-registry`).then((r) => r.json()),
      fetch(`${API_BASE}/api/calendars`, { headers: { Authorization: `Bearer ${auth?.token}` } }).then((r) =>
        r.ok ? r.json() : [],
      ),
      fetch(`${API_BASE}/api/work-order-assignments`).then((r) => r.json()),
      fetch(`${API_BASE}/api/work-orders`).then((r) => r.json()),
    ])
      .then(([m, c, a, wo]) => {
        setMachines(m.filter((x: Machine) => x.isActive));
        setCalendars(c);
        setAssignments(a);
        setWorkOrders(wo);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }

  useEffect(load, [daysToShow]);

  function hoursFromStart(iso: string): number {
    return (new Date(iso).getTime() - windowStart.getTime()) / (1000 * 60 * 60);
  }

  function calendarFor(machine: Machine): Calendar | undefined {
    return calendars.find((c) => c.id === machine.calendarId);
  }

  const scheduledWorkOrderIds = new Set(assignments.map((a) => a.workOrderId));
  const unscheduled = workOrders.filter(
    (wo) => !scheduledWorkOrderIds.has(wo.id) && (wo.status === "planned" || wo.status === "released"),
  );

  async function submitWindow(machineId: string, plannedStart: Date, plannedEnd: Date, existingAssignmentId?: string) {
    setError(null);
    try {
      const validation = await fetch(
        `${API_BASE}/api/machines/${encodeURIComponent(machineId)}/validate-window?start=${plannedStart.toISOString()}&end=${plannedEnd.toISOString()}`,
      ).then((r) => r.json());
      if (!validation.valid) {
        setError(`Cannot schedule here — ${validation.reason ?? "outside working hours"}.`);
        return;
      }

      const url = existingAssignmentId
        ? `${API_BASE}/api/work-order-assignments/${encodeURIComponent(existingAssignmentId)}`
        : `${API_BASE}/api/work-order-assignments`;
      const method = existingAssignmentId ? "PUT" : "POST";
      const body = existingAssignmentId
        ? { machineId, plannedStart: plannedStart.toISOString(), plannedEnd: plannedEnd.toISOString() }
        : {
            workOrderId: draggingWorkOrderIdRef.current,
            machineId,
            plannedStart: plannedStart.toISOString(),
            plannedEnd: plannedEnd.toISOString(),
          };

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        logout();
        throw new Error("session expired — please sign in again");
      }
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `${res.status} ${res.statusText}`);
      }
      load();
    } catch (err) {
      setError(String(err));
    }
  }

  const draggingWorkOrderIdRef = useRef<string | null>(null);
  const draggingAssignmentRef = useRef<Assignment | null>(null);

  async function handleDrop(machineId: string, e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const row = rowRefs.current[machineId];
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const hoursOffset = offsetX / PX_PER_HOUR;
    const rawStart = new Date(windowStart.getTime() + hoursOffset * 60 * 60 * 1000);

    if (draggingAssignmentRef.current) {
      // Meglévő megbízás áthúzása — az eredeti időtartam megmarad, csak eltolódik.
      const a = draggingAssignmentRef.current;
      const durationMs = new Date(a.plannedEnd).getTime() - new Date(a.plannedStart).getTime();
      const plannedStart = snap(rawStart);
      const plannedEnd = new Date(plannedStart.getTime() + durationMs);
      draggingAssignmentRef.current = null;
      await submitWindow(machineId, plannedStart, plannedEnd, a.id);
      return;
    }

    const workOrderId = draggingWorkOrderIdRef.current;
    const workOrder = workOrders.find((wo) => wo.id === workOrderId);
    if (!workOrder) return;
    if (!workOrder.expectedCycleTimeSeconds) {
      setError(`"${workOrder.orderNumber}" has no expected cycle time set — cannot compute duration.`);
      return;
    }
    const plannedStart = snap(rawStart);
    const durationMs = workOrder.expectedCycleTimeSeconds * workOrder.quantity * 1000;
    const plannedEnd = new Date(plannedStart.getTime() + durationMs);
    await submitWindow(machineId, plannedStart, plannedEnd);
  }

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Gantt schedule</h2>

      <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
        <div style={{ width: 200, flexShrink: 0 }}>
          <div style={{ fontSize: 12, color: "#898781", marginBottom: 6 }}>Unscheduled work orders — drag onto a machine row</div>
          {unscheduled.length === 0 && <p style={{ fontSize: 12, color: "#898781" }}>None.</p>}
          {unscheduled.map((wo) => (
            <div
              key={wo.id}
              draggable
              onDragStart={() => {
                draggingWorkOrderIdRef.current = wo.id;
                draggingAssignmentRef.current = null;
                setDraggingId(wo.id);
              }}
              onDragEnd={() => setDraggingId(null)}
              style={{
                border: "1px solid #185fa5",
                borderRadius: 8,
                padding: 8,
                marginBottom: 6,
                fontSize: 12,
                cursor: "grab",
                background: draggingId === wo.id ? "#eef4fb" : "#fff",
              }}
            >
              <div style={{ fontWeight: 600 }}>{wo.orderNumber}</div>
              <div style={{ color: "#898781" }}>{wo.partName} · {wo.quantity} db</div>
              {!wo.expectedCycleTimeSeconds && (
                <div style={{ color: "#d03b3b", fontSize: 11 }}>No cycle time set</div>
              )}
            </div>
          ))}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <label style={{ fontSize: 12 }}>
            Days shown{" "}
            <select value={daysToShow} onChange={(e) => setDaysToShow(Number(e.target.value))} style={{ padding: 4 }}>
              <option value={3}>3</option>
              <option value={7}>7</option>
              <option value={14}>14</option>
            </select>
          </label>

          {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}

          <div style={{ display: "flex", marginTop: 12, border: "1px solid #e1e0d9", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ width: LABEL_WIDTH, flexShrink: 0, borderRight: "1px solid #e1e0d9" }}>
              <div style={{ height: 28, borderBottom: "1px solid #e1e0d9" }} />
              {machines.map((m) => (
                <div
                  key={m.id}
                  style={{
                    height: ROW_HEIGHT,
                    display: "flex",
                    alignItems: "center",
                    padding: "0 10px",
                    borderBottom: "1px solid #f0efeb",
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  {m.name}
                </div>
              ))}
            </div>

            <div style={{ overflowX: "auto", minWidth: 0, flex: 1 }}>
              <div style={{ position: "relative", width: totalWidth }}>
                <div style={{ height: 28, borderBottom: "1px solid #e1e0d9", position: "relative" }}>
                  {Array.from({ length: daysToShow }).map((_, i) => (
                    <div
                      key={i}
                      style={{
                        position: "absolute",
                        left: i * 24 * PX_PER_HOUR,
                        width: 24 * PX_PER_HOUR,
                        fontSize: 11,
                        color: "#898781",
                        borderLeft: "1px solid #e1e0d9",
                        height: "100%",
                        display: "flex",
                        alignItems: "center",
                        paddingLeft: 6,
                      }}
                    >
                      {new Date(windowStart.getTime() + i * 86400000).toLocaleDateString(undefined, {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })}
                    </div>
                  ))}
                </div>

                {machines.map((m) => {
                  const calendar = calendarFor(m);
                  const rowAssignments = assignments.filter((a) => a.machineId === m.id);
                  return (
                    <div
                      key={m.id}
                      ref={(el) => {
                        rowRefs.current[m.id] = el;
                      }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => handleDrop(m.id, e)}
                      style={{ height: ROW_HEIGHT, position: "relative", borderBottom: "1px solid #f0efeb" }}
                    >
                      {calendar &&
                        Array.from({ length: daysToShow }).map((_, i) => {
                          const date = new Date(windowStart.getTime() + i * 86400000);
                          const dow = date.getDay();
                          const isWorking = calendar.workingDays[dow] ?? true;
                          if (isWorking) return null;
                          return (
                            <div
                              key={i}
                              style={{
                                position: "absolute",
                                left: i * 24 * PX_PER_HOUR,
                                width: 24 * PX_PER_HOUR,
                                height: "100%",
                                background:
                                  "repeating-linear-gradient(45deg, #f7f7f5, #f7f7f5 6px, #ecebe6 6px, #ecebe6 12px)",
                              }}
                            />
                          );
                        })}

                      {Array.from({ length: daysToShow + 1 }).map((_, i) => (
                        <div
                          key={i}
                          style={{ position: "absolute", left: i * 24 * PX_PER_HOUR, top: 0, bottom: 0, borderLeft: "1px solid #f0efeb" }}
                        />
                      ))}

                      {rowAssignments.map((a) => {
                        const left = hoursFromStart(a.plannedStart) * PX_PER_HOUR;
                        const width = Math.max(
                          4,
                          (hoursFromStart(a.plannedEnd) - hoursFromStart(a.plannedStart)) * PX_PER_HOUR,
                        );
                        return (
                          <div
                            key={a.id}
                            draggable
                            onDragStart={() => {
                              draggingAssignmentRef.current = a;
                              draggingWorkOrderIdRef.current = null;
                              setDraggingId(a.id);
                            }}
                            onDragEnd={() => setDraggingId(null)}
                            title={`${a.orderNumber} — ${a.partName} (${a.quantity} db) — drag to move`}
                            style={{
                              position: "absolute",
                              left,
                              width,
                              top: 8,
                              height: ROW_HEIGHT - 16,
                              background: "#185fa5",
                              color: "#fff",
                              borderRadius: 6,
                              fontSize: 11,
                              padding: "4px 6px",
                              overflow: "hidden",
                              whiteSpace: "nowrap",
                              textOverflow: "ellipsis",
                              boxSizing: "border-box",
                              cursor: "grab",
                              opacity: draggingId === a.id ? 0.5 : 1,
                            }}
                          >
                            {a.orderNumber}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}