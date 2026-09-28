import { useEffect, useRef, useState } from "react";
import { useAuth } from "./auth-context.js";

interface Machine {
  id: string;
  name: string;
  isActive: boolean;
}

interface OffShiftSegment {
  start: string;
  end: string;
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

type DragState =
  | { type: "workorder"; workOrderId: string; label: string; x: number; y: number }
  | { type: "assignment"; assignment: Assignment; label: string; x: number; y: number };

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
  const [offShiftByMachine, setOffShiftByMachine] = useState<Record<string, OffShiftSegment[]>>({});
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [daysToShow, setDaysToShow] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const windowStart = startOfDay(new Date());
  const windowEnd = new Date(windowStart.getTime() + daysToShow * 24 * 60 * 60 * 1000);
  const totalHours = daysToShow * 24;
  const totalWidth = totalHours * PX_PER_HOUR;

  function load() {
    Promise.all([
      fetch(`${API_BASE}/api/machine-registry`).then((r) => r.json()),
      fetch(`${API_BASE}/api/work-order-assignments`).then((r) => r.json()),
      fetch(`${API_BASE}/api/work-orders`).then((r) => r.json()),
    ])
      .then(([m, a, wo]) => {
        const activeMachines = m.filter((x: Machine) => x.isActive);
        setMachines(activeMachines);
        setAssignments(a);
        setWorkOrders(wo);
        setError(null);

        return Promise.all(
          activeMachines.map((machine: Machine) =>
            fetch(
              `${API_BASE}/api/machines/${encodeURIComponent(machine.id)}/off-shift-segments?from=${windowStart.toISOString()}&to=${windowEnd.toISOString()}`,
            )
              .then((r) => (r.ok ? r.json() : []))
              .then((segments: OffShiftSegment[]) => [machine.id, segments] as const),
          ),
        );
      })
      .then((pairs) => {
        if (!pairs) return;
        const next: Record<string, OffShiftSegment[]> = {};
        for (const [id, segments] of pairs) next[id] = segments;
        setOffShiftByMachine(next);
      })
      .catch((err) => setError(String(err)));
  }

  useEffect(load, [daysToShow]);

  function hoursFromStart(iso: string): number {
    return (new Date(iso).getTime() - windowStart.getTime()) / (1000 * 60 * 60);
  }

  const scheduledWorkOrderIds = new Set(assignments.map((a) => a.workOrderId));
  const unscheduled = workOrders.filter(
    (wo) => !scheduledWorkOrderIds.has(wo.id) && (wo.status === "planned" || wo.status === "released"),
  );

  async function submitWindow(machineId: string, plannedStart: Date, plannedEnd: Date, existingAssignmentId: string | undefined, workOrderId: string | undefined) {
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
        : { workOrderId, machineId, plannedStart: plannedStart.toISOString(), plannedEnd: plannedEnd.toISOString() };

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

  async function computeSegments(
    machineId: string,
    start: Date,
    totalDurationMs: number,
  ): Promise<{ start: Date; end: Date }[]> {
    const bufferEnd = new Date(start.getTime() + totalDurationMs + 30 * 24 * 60 * 60 * 1000);
    const offSegments: OffShiftSegment[] = await fetch(
      `${API_BASE}/api/machines/${encodeURIComponent(machineId)}/off-shift-segments?from=${start.toISOString()}&to=${bufferEnd.toISOString()}`,
    ).then((r) => (r.ok ? r.json() : []));

    const sortedOff = offSegments
      .map((s) => ({ start: new Date(s.start), end: new Date(s.end) }))
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    const workingSegments: { start: Date; end: Date }[] = [];
    let cursor = new Date(start);
    for (const off of sortedOff) {
      if (off.start > cursor) workingSegments.push({ start: new Date(cursor), end: new Date(off.start) });
      if (off.end > cursor) cursor = off.end;
    }
    workingSegments.push({ start: new Date(cursor), end: bufferEnd });

    const chunks: { start: Date; end: Date }[] = [];
    let remaining = totalDurationMs;
    for (const seg of workingSegments) {
      if (remaining <= 0) break;
      const segDuration = seg.end.getTime() - seg.start.getTime();
      if (segDuration <= 0) continue;
      const useDuration = Math.min(segDuration, remaining);
      const chunkEnd = new Date(seg.start.getTime() + useDuration);
      chunks.push({ start: seg.start, end: chunkEnd });
      remaining -= useDuration;
    }
    return chunks;
  }

  async function submitMultiSegment(machineId: string, workOrderId: string, chunks: { start: Date; end: Date }[]) {
    setError(null);
    try {
      for (const chunk of chunks) {
        const res = await fetch(`${API_BASE}/api/work-order-assignments`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
          body: JSON.stringify({
            workOrderId,
            machineId,
            plannedStart: chunk.start.toISOString(),
            plannedEnd: chunk.end.toISOString(),
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
      }
      load();
    } catch (err) {
      setError(String(err));
    }
  }

  async function unscheduleWorkOrder(workOrderId: string) {
    setError(null);
    try {
      const toDelete = assignments.filter((a) => a.workOrderId === workOrderId);
      for (const a of toDelete) {
        const res = await fetch(`${API_BASE}/api/work-order-assignments/${encodeURIComponent(a.id)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${auth?.token}` },
        });
        if (res.status === 401) {
          logout();
          throw new Error("session expired — please sign in again");
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `${res.status} ${res.statusText}`);
        }
      }
      load();
    } catch (err) {
      setError(String(err));
    }
  }

  // Saját, eger-alapú drag-implementáció — a natív HTML5 DnD API
  // Safari-n megbízhatatlan sima <div>-ekkel, ezért mousedown/mousemove/
  // mouseup eseményekkel, document.elementFromPoint-tal valósítjuk meg,
  // ami minden böngészőben egyformán működik.
  useEffect(() => {
    if (!drag) return;

    function onMove(e: MouseEvent) {
      setDrag((d) => (d ? { ...d, x: e.clientX, y: e.clientY } : d));
    }

    async function onUp(e: MouseEvent) {
      const current = dragRef.current;
      setDrag(null);
      if (!current) return;

      const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const rowEl = target?.closest("[data-machine-row]") as HTMLElement | null;
      const poolEl = target?.closest("[data-pool]") as HTMLElement | null;

      if (poolEl && current.type === "assignment") {
        await unscheduleWorkOrder(current.assignment.workOrderId);
        return;
      }

      if (!rowEl) return;
      const machineId = rowEl.dataset.machineRow!;
      const rect = rowEl.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const hoursOffset = offsetX / PX_PER_HOUR;
      const rawStart = new Date(windowStart.getTime() + hoursOffset * 60 * 60 * 1000);

      if (current.type === "assignment") {
        const a = current.assignment;
        const durationMs = new Date(a.plannedEnd).getTime() - new Date(a.plannedStart).getTime();
        const plannedStart = snap(rawStart);
        const plannedEnd = new Date(plannedStart.getTime() + durationMs);
        await submitWindow(machineId, plannedStart, plannedEnd, a.id, undefined);
        return;
      }

      const workOrder = workOrders.find((wo) => wo.id === current.workOrderId);
      if (!workOrder) return;
      if (!workOrder.expectedCycleTimeSeconds) {
        setError(`"${workOrder.orderNumber}" has no expected cycle time set — cannot compute duration.`);
        return;
      }
      const plannedStart = snap(rawStart);
      const durationMs = workOrder.expectedCycleTimeSeconds * workOrder.quantity * 1000;
      const chunks = await computeSegments(machineId, plannedStart, durationMs);
      if (chunks.length === 0) {
        setError("Could not find any working time to schedule this order.");
        return;
      }
      await submitMultiSegment(machineId, current.workOrderId, chunks);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Gantt schedule</h2>

      {drag && (
        <div
          style={{
            position: "fixed",
            left: drag.x + 12,
            top: drag.y + 12,
            zIndex: 1000,
            pointerEvents: "none",
            background: "#0b0b0b",
            color: "#fff",
            padding: "6px 10px",
            borderRadius: 6,
            fontSize: 12,
            boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
          }}
        >
          {drag.label}
        </div>
      )}

      <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
        <div data-pool="true" style={{ width: 200, flexShrink: 0, minHeight: 400 }}>
          <div style={{ fontSize: 12, color: "#898781", marginBottom: 6 }}>
            Unscheduled work orders — drag onto a machine row; drag a scheduled bar back here to remove it
          </div>
          {unscheduled.length === 0 && <p style={{ fontSize: 12, color: "#898781" }}>None.</p>}
          {unscheduled.map((wo) => (
            <div
              key={wo.id}
              onMouseDown={(e) => {
                e.preventDefault();
                setDrag({ type: "workorder", workOrderId: wo.id, label: wo.orderNumber, x: e.clientX, y: e.clientY });
              }}
              style={{
                border: "1px solid #185fa5",
                borderRadius: 8,
                padding: 8,
                marginBottom: 6,
                fontSize: 12,
                cursor: "grab",
                background: "#fff",
                userSelect: "none",
              }}
            >
              <div style={{ fontWeight: 600 }}>{wo.orderNumber}</div>
              <div style={{ color: "#898781" }}>{wo.partName} · {wo.quantity} db</div>
              {!wo.expectedCycleTimeSeconds && <div style={{ color: "#d03b3b", fontSize: 11 }}>No cycle time set</div>}
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
                  const rowAssignments = assignments.filter((a) => a.machineId === m.id);
                  const offSegments = offShiftByMachine[m.id] ?? [];
                  return (
                    <div
                      key={m.id}
                      data-machine-row={m.id}
                      style={{ height: ROW_HEIGHT, position: "relative", borderBottom: "1px solid #f0efeb" }}
                    >
                      {offSegments.map((seg, i) => {
                        const left = hoursFromStart(seg.start) * PX_PER_HOUR;
                        const width = Math.max(0, (hoursFromStart(seg.end) - hoursFromStart(seg.start)) * PX_PER_HOUR);
                        if (width <= 0) return null;
                        return (
                          <div
                            key={i}
                            style={{
                              position: "absolute",
                              left,
                              width,
                              height: "100%",
                              background: "repeating-linear-gradient(45deg, #f7f7f5, #f7f7f5 6px, #ecebe6 6px, #ecebe6 12px)",
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
                        const width = Math.max(4, (hoursFromStart(a.plannedEnd) - hoursFromStart(a.plannedStart)) * PX_PER_HOUR);
                        const isBeingDragged = drag?.type === "assignment" && drag.assignment.id === a.id;
                        return (
                          <div
                            key={a.id}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              setDrag({ type: "assignment", assignment: a, label: `${a.orderNumber} — ${a.partName}`, x: e.clientX, y: e.clientY });
                            }}
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
                              opacity: isBeingDragged ? 0.4 : 1,
                              userSelect: "none",
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