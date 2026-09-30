import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE } from "./api.js";

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

/**
 * Egy munkarendelés összes szegmense egy csoportban. A mozgatás és az
 * átméretezés mindig a teljes rendelésre vonatkozik, nem egy-egy szegmensre —
 * a szegmenseket a szerver osztja újra a gép munkaidő-ablakai szerint.
 */
interface OrderGroup {
  workOrderId: string;
  machineId: string;
  segments: Assignment[];
  firstStartMs: number;
  lastEndMs: number;
  workingMs: number;
}

type DragState =
  | {
      type: "workorder";
      workOrderId: string;
      label: string;
      x: number;
      y: number;
      hoverMachineId: string | null;
      hoverStartMs: number | null;
    }
  | {
      type: "move";
      workOrderId: string;
      label: string;
      x: number;
      y: number;
      originX: number;
      originMachineId: string;
      firstStartMs: number;
      workingMs: number;
      hoverMachineId: string | null;
      overPool: boolean;
    }
  | {
      type: "resize";
      workOrderId: string;
      label: string;
      x: number;
      y: number;
      machineId: string;
      edge: "start" | "end";
      fixedMs: number;
      originalMs: number;
      currentMs: number;
    };

type ScheduleRequest =
  | { machineId: string; plannedStart: string; durationMs: number }
  | { machineId: string; plannedStart: string; plannedEnd: string };

const PX_PER_HOUR = 40;
const ROW_HEIGHT = 56;
const LABEL_WIDTH = 160;
const SNAP_MINUTES = 15;
const HOUR_MS = 60 * 60 * 1000;
const SNAP_MS = SNAP_MINUTES * 60 * 1000;
const MIN_SPAN_MS = SNAP_MS;
const DAY_HEADER_HEIGHT = 24;
const HOUR_HEADER_HEIGHT = 18;
const HEADER_HEIGHT = DAY_HEADER_HEIGHT + HOUR_HEADER_HEIGHT;
/** Az idősávok szélessége órában — a fejléc óracímkéi is ehhez igazodnak. */
const BAND_HOURS = 2;
const HANDLE_WIDTH = 7;
/** Ennél kisebb elmozdulás kattintásnak számít, nem mozgatásnak. */
const CLICK_THRESHOLD_PX = 3;
/** Ennyi eltérés alatt nem jelezzük, hogy a tervezett munkaidő rövidebb a számítottnál. */
const UNDERPLAN_TOLERANCE_MS = 60 * 1000;

const COLORS = {
  border: "#e1e0d9",
  hairline: "#f0efeb",
  dayLine: "#d6d4cc",
  band: "#f6f5f1",
  muted: "#898781",
  text: "#5f5e5a",
  bar: "#185fa5",
  danger: "#d03b3b",
  warn: "#e8a33d",
};

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

/** Naptári nap hozzáadása helyi idő szerint — DST-váltáskor is éjfélre esik. */
function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

function snapMs(ms: number): number {
  return Math.round(ms / SNAP_MS) * SNAP_MS;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Munkaidő egy falióra-intervallumban, a betöltött off-shift szegmensek alapján (előnézethez). */
function workingMsInSpan(startMs: number, endMs: number, offShift: OffShiftSegment[]): number {
  let offMs = 0;
  for (const seg of offShift) {
    const s = Math.max(startMs, Date.parse(seg.start));
    const e = Math.min(endMs, Date.parse(seg.end));
    if (e > s) offMs += e - s;
  }
  return Math.max(0, endMs - startMs - offMs);
}

function requiredMs(wo: WorkOrder | undefined): number | null {
  return wo?.expectedCycleTimeSeconds ? wo.expectedCycleTimeSeconds * wo.quantity * 1000 : null;
}

function machineRowAt(x: number, y: number): HTMLElement | null {
  const target = document.elementFromPoint(x, y) as HTMLElement | null;
  return (target?.closest("[data-machine-row]") as HTMLElement | null) ?? null;
}

function isOverPool(x: number, y: number): boolean {
  const target = document.elementFromPoint(x, y) as HTMLElement | null;
  return Boolean(target?.closest("[data-pool]"));
}

function ResizeHandle({ side, onMouseDown }: { side: "start" | "end"; onMouseDown: (e: ReactMouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      title={side === "start" ? "Drag to change the start" : "Drag to change the end"}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        ...(side === "start" ? { left: 0 } : { right: 0 }),
        width: HANDLE_WIDTH,
        cursor: "ew-resize",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{ width: 2, height: 14, borderRadius: 1, background: "rgba(255,255,255,0.55)" }} />
    </div>
  );
}

export default function GanttSchedulePanel() {
  const { auth, logout } = useAuth();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [offShiftByMachine, setOffShiftByMachine] = useState<Record<string, OffShiftSegment[]>>({});
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [daysToShow, setDaysToShow] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledForRef = useRef<string | null>(null);

  // Az idővonal helyi éjféltől indul, napokat naptár szerint lép (nem 24 óra
  // ms-ban), így a DST-váltás napja 23 vagy 25 óra széles lesz, és utána a
  // címkék, sávok és barok is a valódi időpontjukon maradnak.
  const windowStartMs = startOfDay(new Date(nowMs)).getTime();
  const windowEndMs = addDays(new Date(windowStartMs), daysToShow).getTime();
  const totalWidth = ((windowEndMs - windowStartMs) / HOUR_MS) * PX_PER_HOUR;

  const xFromMs = (ms: number) => ((ms - windowStartMs) / HOUR_MS) * PX_PER_HOUR;
  const msFromX = (x: number) => windowStartMs + (x / PX_PER_HOUR) * HOUR_MS;

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  function load() {
    const fromIso = new Date(windowStartMs).toISOString();
    const toIso = new Date(windowEndMs).toISOString();
    Promise.all([
      apiFetch(`${API_BASE}/api/machine-registry`).then((r) => r.json()),
      apiFetch(`${API_BASE}/api/work-order-assignments`).then((r) => r.json()),
      apiFetch(`${API_BASE}/api/work-orders`).then((r) => r.json()),
    ])
      .then(([m, a, wo]) => {
        const activeMachines = m.filter((x: Machine) => x.isActive);
        setMachines(activeMachines);
        setAssignments(a);
        setWorkOrders(wo);

        return Promise.all(
          activeMachines.map((machine: Machine) =>
            apiFetch(
              `${API_BASE}/api/machines/${encodeURIComponent(machine.id)}/off-shift-segments?from=${fromIso}&to=${toIso}`,
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

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [daysToShow, windowStartMs]);

  // Első betöltéskor az idővonalat a "most" környékére görgetjük.
  useEffect(() => {
    const key = `${windowStartMs}:${daysToShow}`;
    const el = scrollRef.current;
    if (!el || machines.length === 0 || scrolledForRef.current === key) return;
    scrolledForRef.current = key;
    el.scrollLeft = Math.max(0, xFromMs(Date.now()) - el.clientWidth * 0.25);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowStartMs, daysToShow, machines.length]);

  const hourTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let t = windowStartMs; t < windowEndMs; t += HOUR_MS) ticks.push(t);
    return ticks;
  }, [windowStartMs, windowEndMs]);

  const dayStarts = useMemo(
    () => Array.from({ length: daysToShow }, (_, i) => addDays(new Date(windowStartMs), i).getTime()),
    [windowStartMs, daysToShow],
  );

  const groups = useMemo(() => {
    const byOrder = new Map<string, Assignment[]>();
    for (const a of assignments) {
      const list = byOrder.get(a.workOrderId);
      if (list) list.push(a);
      else byOrder.set(a.workOrderId, [a]);
    }
    const result = new Map<string, OrderGroup>();
    for (const [workOrderId, segments] of byOrder) {
      segments.sort((x, y) => Date.parse(x.plannedStart) - Date.parse(y.plannedStart));
      const first = segments[0]!;
      const last = segments[segments.length - 1]!;
      result.set(workOrderId, {
        workOrderId,
        machineId: first.machineId,
        segments,
        firstStartMs: Date.parse(first.plannedStart),
        lastEndMs: Date.parse(last.plannedEnd),
        workingMs: segments.reduce((sum, s) => sum + Date.parse(s.plannedEnd) - Date.parse(s.plannedStart), 0),
      });
    }
    return result;
  }, [assignments]);

  const workOrderById = useMemo(() => new Map(workOrders.map((wo) => [wo.id, wo])), [workOrders]);
  const machineNameById = useMemo(() => new Map(machines.map((m) => [m.id, m.name])), [machines]);

  const unscheduled = workOrders.filter(
    (wo) => !groups.has(wo.id) && (wo.status === "planned" || wo.status === "released"),
  );

  async function apiRequest(path: string, init: RequestInit): Promise<void> {
    const res = await apiFetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${auth?.token}`,
      },
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

  async function runMutation(fn: () => Promise<void>) {
    setSaving(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
      load();
    }
  }

  function saveSchedule(workOrderId: string, body: ScheduleRequest) {
    return runMutation(() =>
      apiRequest(`/api/work-orders/${encodeURIComponent(workOrderId)}/schedule`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    );
  }

  function clearSchedule(workOrderId: string) {
    return runMutation(() =>
      apiRequest(`/api/work-orders/${encodeURIComponent(workOrderId)}/schedule`, { method: "DELETE" }),
    );
  }

  function startResize(e: ReactMouseEvent, group: OrderGroup, edge: "start" | "end", label: string) {
    if (e.button !== 0 || saving) return;
    e.preventDefault();
    e.stopPropagation();
    const originalMs = edge === "end" ? group.lastEndMs : group.firstStartMs;
    const fixedMs = edge === "end" ? group.firstStartMs : group.lastEndMs;
    setDrag({
      type: "resize",
      workOrderId: group.workOrderId,
      label,
      x: e.clientX,
      y: e.clientY,
      machineId: group.machineId,
      edge,
      fixedMs,
      originalMs,
      currentMs: originalMs,
    });
  }

  // Saját, egér-alapú drag-implementáció — a natív HTML5 DnD API
  // Safari-n megbízhatatlan sima <div>-ekkel, ezért mousedown/mousemove/
  // mouseup eseményekkel, document.elementFromPoint-tal valósítjuk meg,
  // ami minden böngészőben egyformán működik. A listenerek a drag teljes
  // idejére egyszer regisztrálódnak; az aktuális állapotot a dragRef adja.
  const dragActive = drag !== null;
  useEffect(() => {
    if (!dragActive) return;

    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = dragRef.current?.type === "resize" ? "ew-resize" : "grabbing";

    function onMove(e: MouseEvent) {
      const current = dragRef.current;
      if (!current) return;

      if (current.type === "resize") {
        const rowEl = document.querySelector(
          `[data-machine-row="${CSS.escape(current.machineId)}"]`,
        ) as HTMLElement | null;
        if (!rowEl) return;
        const rect = rowEl.getBoundingClientRect();
        const raw = snapMs(msFromX(e.clientX - rect.left));
        const currentMs =
          current.edge === "end"
            ? Math.max(raw, current.fixedMs + MIN_SPAN_MS)
            : Math.min(raw, current.fixedMs - MIN_SPAN_MS);
        setDrag({ ...current, currentMs, x: e.clientX, y: e.clientY });
        return;
      }

      const rowEl = machineRowAt(e.clientX, e.clientY);
      const hoverMachineId = rowEl?.dataset.machineRow ?? null;

      if (current.type === "move") {
        setDrag({ ...current, x: e.clientX, y: e.clientY, hoverMachineId, overPool: isOverPool(e.clientX, e.clientY) });
        return;
      }

      const hoverStartMs = rowEl ? snapMs(msFromX(e.clientX - rowEl.getBoundingClientRect().left)) : null;
      setDrag({ ...current, x: e.clientX, y: e.clientY, hoverMachineId, hoverStartMs });
    }

    async function onUp(e: MouseEvent) {
      const current = dragRef.current;
      setDrag(null);
      if (!current) return;

      if (current.type === "resize") {
        if (current.currentMs === current.originalMs) return;
        const [startMs, endMs] =
          current.edge === "end" ? [current.fixedMs, current.currentMs] : [current.currentMs, current.fixedMs];
        await saveSchedule(current.workOrderId, {
          machineId: current.machineId,
          plannedStart: new Date(startMs).toISOString(),
          plannedEnd: new Date(endMs).toISOString(),
        });
        return;
      }

      const rowEl = machineRowAt(e.clientX, e.clientY);

      if (current.type === "move") {
        if (isOverPool(e.clientX, e.clientY)) {
          await clearSchedule(current.workOrderId);
          return;
        }
        if (!rowEl) return;
        const machineId = rowEl.dataset.machineRow!;
        const dx = e.clientX - current.originX;
        if (Math.abs(dx) < CLICK_THRESHOLD_PX && machineId === current.originMachineId) return;
        const plannedStart = snapMs(current.firstStartMs + (dx / PX_PER_HOUR) * HOUR_MS);
        await saveSchedule(current.workOrderId, {
          machineId,
          plannedStart: new Date(plannedStart).toISOString(),
          durationMs: current.workingMs,
        });
        return;
      }

      if (!rowEl) return;
      const workOrder = workOrderById.get(current.workOrderId);
      if (!workOrder) return;
      const durationMs = requiredMs(workOrder);
      if (durationMs === null) {
        setError(`"${workOrder.orderNumber}" has no expected cycle time set — cannot compute duration.`);
        return;
      }
      const plannedStart = snapMs(msFromX(e.clientX - rowEl.getBoundingClientRect().left));
      await saveSchedule(workOrder.id, {
        machineId: rowEl.dataset.machineRow!,
        plannedStart: new Date(plannedStart).toISOString(),
        durationMs,
      });
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = previousCursor;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragActive]);

  function tooltipLines(d: DragState): string[] {
    if (d.type === "resize") {
      const startMs = Math.min(d.fixedMs, d.currentMs);
      const endMs = Math.max(d.fixedMs, d.currentMs);
      const working = workingMsInSpan(startMs, endMs, offShiftByMachine[d.machineId] ?? []);
      const required = requiredMs(workOrderById.get(d.workOrderId));
      return [
        d.label,
        `${formatTime(startMs)} → ${formatTime(endMs)}`,
        `Working time ≈ ${formatDuration(working)}${required !== null ? ` (required ${formatDuration(required)})` : ""}`,
      ];
    }
    if (d.type === "move") {
      if (d.overPool) return [d.label, "Release to unschedule"];
      if (!d.hoverMachineId) return [d.label];
      const startMs = snapMs(d.firstStartMs + ((d.x - d.originX) / PX_PER_HOUR) * HOUR_MS);
      return [
        d.label,
        `${machineNameById.get(d.hoverMachineId) ?? d.hoverMachineId}, from ${formatTime(startMs)}`,
        `Working time ${formatDuration(d.workingMs)}`,
      ];
    }
    if (!d.hoverMachineId || d.hoverStartMs === null) return [d.label];
    const required = requiredMs(workOrderById.get(d.workOrderId));
    return [
      d.label,
      `${machineNameById.get(d.hoverMachineId) ?? d.hoverMachineId}, from ${formatTime(d.hoverStartMs)}`,
      required !== null ? `Working time ${formatDuration(required)}` : "No cycle time set",
    ];
  }

  const showNowLine = nowMs >= windowStartMs && nowMs < windowEndMs;

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Gantt schedule</h2>

      {drag && (
        <div
          style={{
            position: "fixed",
            left: drag.x + 14,
            top: drag.y + 14,
            zIndex: 1000,
            pointerEvents: "none",
            background: "#1f2328",
            color: "#fff",
            padding: "6px 10px",
            borderRadius: 6,
            fontSize: 12,
            lineHeight: 1.45,
            boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
            whiteSpace: "nowrap",
          }}
        >
          {tooltipLines(drag).map((line, i) => (
            <div key={i} style={i === 0 ? { fontWeight: 600 } : { opacity: 0.85 }}>
              {line}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
        <div data-pool="true" style={{ width: 200, flexShrink: 0, minHeight: 400 }}>
          <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 6 }}>
            Unscheduled work orders — drag onto a machine row; drag a scheduled bar back here to remove it
          </div>
          {unscheduled.length === 0 && <p style={{ fontSize: 12, color: COLORS.muted }}>None.</p>}
          {unscheduled.map((wo) => (
            <div
              key={wo.id}
              onMouseDown={(e) => {
                if (e.button !== 0 || saving) return;
                e.preventDefault();
                setDrag({
                  type: "workorder",
                  workOrderId: wo.id,
                  label: wo.orderNumber,
                  x: e.clientX,
                  y: e.clientY,
                  hoverMachineId: null,
                  hoverStartMs: null,
                });
              }}
              style={{
                border: `1px solid ${COLORS.bar}`,
                borderRadius: 8,
                padding: 8,
                marginBottom: 6,
                fontSize: 12,
                cursor: saving ? "progress" : "grab",
                background: "#fff",
                userSelect: "none",
              }}
            >
              <div style={{ fontWeight: 600 }}>{wo.orderNumber}</div>
              <div style={{ color: COLORS.muted }}>
                {wo.partName} · {wo.quantity} db
              </div>
              {!wo.expectedCycleTimeSeconds && (
                <div style={{ color: COLORS.danger, fontSize: 11 }}>No cycle time set</div>
              )}
            </div>
          ))}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <label style={{ fontSize: 12 }}>
              Days shown{" "}
              <select value={daysToShow} onChange={(e) => setDaysToShow(Number(e.target.value))} style={{ padding: 4 }}>
                <option value={3}>3</option>
                <option value={7}>7</option>
                <option value={14}>14</option>
              </select>
            </label>
            {saving && <span style={{ fontSize: 12, color: COLORS.muted }}>Saving…</span>}
          </div>

          {error && <p style={{ color: COLORS.danger, fontSize: 13 }}>{error}</p>}

          <div
            style={{
              display: "flex",
              marginTop: 12,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 10,
              overflow: "hidden",
            }}
          >
            <div style={{ width: LABEL_WIDTH, flexShrink: 0, borderRight: `1px solid ${COLORS.border}` }}>
              <div style={{ height: HEADER_HEIGHT, borderBottom: `1px solid ${COLORS.border}` }} />
              {machines.map((m) => (
                <div
                  key={m.id}
                  style={{
                    height: ROW_HEIGHT,
                    display: "flex",
                    alignItems: "center",
                    padding: "0 10px",
                    borderBottom: `1px solid ${COLORS.hairline}`,
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  {m.name}
                </div>
              ))}
            </div>

            <div ref={scrollRef} style={{ overflowX: "auto", minWidth: 0, flex: 1 }}>
              <div style={{ position: "relative", width: totalWidth }}>
                {/* Fejléc: napok felül, óracímkék BAND_HOURS-onként alul */}
                <div
                  style={{
                    position: "relative",
                    height: HEADER_HEIGHT,
                    borderBottom: `1px solid ${COLORS.border}`,
                    background: "#fff",
                    zIndex: 2,
                  }}
                >
                  {dayStarts.map((ms, i) => {
                    const nextMs = dayStarts[i + 1] ?? windowEndMs;
                    return (
                      <div
                        key={ms}
                        style={{
                          position: "absolute",
                          left: xFromMs(ms),
                          width: xFromMs(nextMs) - xFromMs(ms),
                          top: 0,
                          height: DAY_HEADER_HEIGHT,
                          borderLeft: `1px solid ${COLORS.dayLine}`,
                          boxSizing: "border-box",
                          display: "flex",
                          alignItems: "center",
                          paddingLeft: 6,
                          fontSize: 11,
                          fontWeight: 600,
                          color: COLORS.text,
                        }}
                      >
                        {new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                      </div>
                    );
                  })}
                  {hourTicks.map((t) => {
                    const hour = new Date(t).getHours();
                    if (hour % BAND_HOURS !== 0) return null;
                    return (
                      <div
                        key={t}
                        style={{
                          position: "absolute",
                          left: xFromMs(t),
                          top: DAY_HEADER_HEIGHT,
                          height: HOUR_HEADER_HEIGHT,
                          borderLeft: `1px solid ${COLORS.border}`,
                          paddingLeft: 3,
                          fontSize: 10,
                          color: COLORS.muted,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {String(hour).padStart(2, "0")}:00
                      </div>
                    );
                  })}
                </div>

                {/* Háttér-idősávok: váltakozó BAND_HOURS széles csíkok, óránkénti
                    hajszálvonal, erősebb napi határ. Egyetlen réteg az összes gép
                    mögött (nem soronként), pointer-eventek nélkül, hogy az
                    elementFromPoint-os drop-detektálást ne zavarja. */}
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    top: HEADER_HEIGHT,
                    bottom: 0,
                    left: 0,
                    width: totalWidth,
                    pointerEvents: "none",
                    zIndex: 0,
                  }}
                >
                  {hourTicks.map((t) => {
                    const shaded = Math.floor(new Date(t).getHours() / BAND_HOURS) % 2 === 1;
                    return (
                      <div
                        key={t}
                        style={{
                          position: "absolute",
                          left: xFromMs(t),
                          width: PX_PER_HOUR,
                          top: 0,
                          bottom: 0,
                          background: shaded ? COLORS.band : "transparent",
                          borderLeft: `1px solid ${COLORS.hairline}`,
                        }}
                      />
                    );
                  })}
                  {dayStarts.map((ms) => (
                    <div
                      key={ms}
                      style={{ position: "absolute", left: xFromMs(ms), top: 0, bottom: 0, borderLeft: `1px solid ${COLORS.dayLine}` }}
                    />
                  ))}
                </div>

                {showNowLine && (
                  <div
                    aria-hidden
                    title="Now"
                    style={{
                      position: "absolute",
                      left: xFromMs(nowMs),
                      top: 0,
                      bottom: 0,
                      borderLeft: `2px solid ${COLORS.danger}`,
                      zIndex: 3,
                      pointerEvents: "none",
                    }}
                  />
                )}

                {machines.map((m) => {
                  const rowAssignments = assignments.filter((a) => a.machineId === m.id);
                  const offSegments = offShiftByMachine[m.id] ?? [];
                  const isDropTarget =
                    (drag?.type === "move" || drag?.type === "workorder") && drag.hoverMachineId === m.id;
                  const ghost =
                    drag?.type === "resize" && drag.machineId === m.id
                      ? { startMs: Math.min(drag.fixedMs, drag.currentMs), endMs: Math.max(drag.fixedMs, drag.currentMs) }
                      : null;

                  return (
                    <div
                      key={m.id}
                      data-machine-row={m.id}
                      style={{
                        height: ROW_HEIGHT,
                        position: "relative",
                        zIndex: 1,
                        borderBottom: `1px solid ${COLORS.hairline}`,
                        background: isDropTarget ? "rgba(24,95,165,0.06)" : "transparent",
                      }}
                    >
                      {offSegments.map((seg, i) => {
                        const left = xFromMs(Date.parse(seg.start));
                        const width = Math.max(0, xFromMs(Date.parse(seg.end)) - left);
                        if (width <= 0) return null;
                        return (
                          <div
                            key={i}
                            style={{
                              position: "absolute",
                              left,
                              width,
                              height: "100%",
                              // Félig átlátszó, hogy a háttér-idősávok átlátszódjanak.
                              background:
                                "repeating-linear-gradient(45deg, rgba(137,135,129,0.08), rgba(137,135,129,0.08) 6px, rgba(137,135,129,0.2) 6px, rgba(137,135,129,0.2) 12px)",
                            }}
                          />
                        );
                      })}

                      {rowAssignments.map((a) => {
                        const group = groups.get(a.workOrderId);
                        if (!group) return null;
                        const startMs = Date.parse(a.plannedStart);
                        const endMs = Date.parse(a.plannedEnd);
                        const left = xFromMs(startMs);
                        const width = Math.max(4, xFromMs(endMs) - left);
                        const isFirst = group.segments[0]?.id === a.id;
                        const isLast = group.segments[group.segments.length - 1]?.id === a.id;
                        const isActive = drag !== null && drag.type !== "workorder" && drag.workOrderId === a.workOrderId;
                        const required = requiredMs(workOrderById.get(a.workOrderId));
                        const underPlanned = required !== null && group.workingMs + UNDERPLAN_TOLERANCE_MS < required;
                        const label = `${a.orderNumber} — ${a.partName}`;
                        const segmentInfo =
                          group.segments.length > 1
                            ? `\nPart ${group.segments.indexOf(a) + 1} of ${group.segments.length}, ${formatTime(group.firstStartMs)} → ${formatTime(group.lastEndMs)}`
                            : "";
                        const title =
                          `${label} (${a.quantity} db)\n${formatTime(startMs)} → ${formatTime(endMs)}${segmentInfo}` +
                          `\nPlanned working time ${formatDuration(group.workingMs)}` +
                          (underPlanned ? `, shorter than the required ${formatDuration(required!)}` : "") +
                          `\nDrag to move the whole order, drag its outer edges to resize`;

                        return (
                          <div
                            key={a.id}
                            onMouseDown={(e) => {
                              if (e.button !== 0 || saving) return;
                              e.preventDefault();
                              setDrag({
                                type: "move",
                                workOrderId: a.workOrderId,
                                label,
                                x: e.clientX,
                                y: e.clientY,
                                originX: e.clientX,
                                originMachineId: m.id,
                                firstStartMs: group.firstStartMs,
                                workingMs: group.workingMs,
                                hoverMachineId: m.id,
                                overPool: false,
                              });
                            }}
                            title={title}
                            style={{
                              position: "absolute",
                              left,
                              width,
                              top: 8,
                              height: ROW_HEIGHT - 16,
                              background: COLORS.bar,
                              color: "#fff",
                              borderRadius: 6,
                              fontSize: 11,
                              padding: `4px ${HANDLE_WIDTH + 2}px`,
                              overflow: "hidden",
                              whiteSpace: "nowrap",
                              textOverflow: "ellipsis",
                              boxSizing: "border-box",
                              cursor: saving ? "progress" : "grab",
                              opacity: isActive ? 0.35 : 1,
                              boxShadow: underPlanned ? `inset 0 -3px 0 ${COLORS.warn}` : undefined,
                              userSelect: "none",
                            }}
                          >
                            {a.orderNumber}
                            {isFirst && width >= HANDLE_WIDTH * 3 && (
                              <ResizeHandle side="start" onMouseDown={(e) => startResize(e, group, "start", label)} />
                            )}
                            {isLast && (
                              <ResizeHandle side="end" onMouseDown={(e) => startResize(e, group, "end", label)} />
                            )}
                          </div>
                        );
                      })}

                      {ghost && (
                        <div
                          style={{
                            position: "absolute",
                            left: xFromMs(ghost.startMs),
                            width: Math.max(4, xFromMs(ghost.endMs) - xFromMs(ghost.startMs)),
                            top: 8,
                            height: ROW_HEIGHT - 16,
                            border: `2px dashed ${COLORS.bar}`,
                            background: "rgba(24,95,165,0.12)",
                            borderRadius: 6,
                            boxSizing: "border-box",
                            pointerEvents: "none",
                          }}
                        />
                      )}
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
