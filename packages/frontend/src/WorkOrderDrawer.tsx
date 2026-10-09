import { useEffect, useState, type FormEvent } from "react";
import Drawer from "./ui/Drawer.js";
import Field from "./ui/Field.js";
import { apiFetch, API_BASE } from "./api.js";
import { ApiError, readJsonOrThrow, type Machine } from "./master-data.js";
import { endOfDay, formatDateTime, formatDuration, fromLocalInput, toLocalInput } from "./ui/format.js";
import InstructionViewer from "./InstructionViewer.js";
import { instructionForOrder, listInstructions, type WorkInstruction } from "./work-instructions.js";

export type WorkOrderStatus = "planned" | "released" | "in_progress" | "completed" | "cancelled";

export const STATUS_LABEL: Record<WorkOrderStatus, string> = {
  planned: "Planned",
  released: "Released",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

export interface WorkOrder {
  id: string;
  orderNumber: string;
  partName: string;
  quantity: number;
  expectedCycleTimeSeconds: number | null;
  dueDate: string | null;
  status: WorkOrderStatus;
  notes: string | null;
  completionMode: "manual" | "auto";
  countOverproduction: boolean;
  createdAt: string;
  /** Chosen work instruction, by name; null = automatic (the one named like the part). */
  workInstructionName: string | null;
  materials: WorkOrderMaterial[];
  schedule: {
    machineId: string;
    machineName: string;
    plannedStart: string;
    plannedEnd: string;
    plannedSeconds: number;
    segments: number;
  } | null;
}

export interface WorkOrderMaterial {
  materialLotId: string;
  materialName: string;
  lotNumber: string;
}

interface MaterialLot {
  id: string;
  materialName: string;
  lotNumber: string;
  supplier: string | null;
  receivedAt: string | null;
}

export type WorkOrderTarget = { mode: "edit"; workOrder: WorkOrder } | { mode: "create"; copyOf?: WorkOrder };

/** A tervezett befejezés a határidő napja után van-e. */
export function isLate(wo: WorkOrder): boolean {
  if (!wo.dueDate || wo.status === "completed" || wo.status === "cancelled") return false;
  const due = endOfDay(wo.dueDate);
  if (wo.schedule) return new Date(wo.schedule.plannedEnd).getTime() > due;
  return Date.now() > due;
}

/** A szükséges munkaidő (ciklusidő × darabszám); ciklusidő hiányában a gép ideális ciklusideje. */
export function requiredSeconds(wo: Pick<WorkOrder, "expectedCycleTimeSeconds" | "quantity">, machine?: Machine): number | null {
  const cycle = wo.expectedCycleTimeSeconds ?? machine?.idealCycleTimeSeconds ?? null;
  return cycle ? cycle * wo.quantity : null;
}

interface Draft {
  orderNumber: string;
  partName: string;
  quantity: string;
  expectedCycleTimeSeconds: string;
  dueDate: string;
  notes: string;
  status: WorkOrderStatus;
  completionMode: "manual" | "auto";
  countOverproduction: boolean;
  /** "" = automatic. */
  workInstructionName: string;
}

function toDraft(wo: WorkOrder | undefined, copy: boolean): Draft {
  return {
    orderNumber: wo && !copy ? wo.orderNumber : "",
    partName: wo?.partName ?? "",
    quantity: wo ? String(wo.quantity) : "",
    expectedCycleTimeSeconds: wo?.expectedCycleTimeSeconds !== null && wo?.expectedCycleTimeSeconds !== undefined ? String(wo.expectedCycleTimeSeconds) : "",
    dueDate: wo?.dueDate ?? "",
    notes: wo?.notes ?? "",
    status: wo && !copy ? wo.status : "planned",
    completionMode: wo?.completionMode ?? "manual",
    countOverproduction: wo?.countOverproduction ?? true,
    workInstructionName: wo?.workInstructionName ?? "",
  };
}

function toPayload(d: Draft): Record<string, unknown> {
  const cycle = d.expectedCycleTimeSeconds.trim();
  return {
    partName: d.partName.trim(),
    quantity: Number(d.quantity),
    expectedCycleTimeSeconds: cycle === "" ? null : Number(cycle),
    dueDate: d.dueDate || null,
    notes: d.notes.trim() === "" ? null : d.notes,
    status: d.status,
    completionMode: d.completionMode,
    countOverproduction: d.countOverproduction,
    workInstructionName: d.workInstructionName || null,
  };
}

function localErrors(d: Draft, creating: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (creating && d.orderNumber.trim() === "") e.orderNumber = "Enter an order number.";
  if (d.partName.trim() === "") e.partName = "Enter the part.";
  const q = Number(d.quantity);
  if (!Number.isInteger(q) || q < 1) e.quantity = "Enter a whole number of at least 1.";
  const c = d.expectedCycleTimeSeconds.trim();
  if (c !== "" && !(Number(c) > 0)) e.expectedCycleTimeSeconds = "Enter a positive number of seconds, or leave empty.";
  return e;
}

/**
 * Gyártási rendelés szerkesztője. A törzsadat a lap alján lévő gombbal
 * mentődik (PATCH, egy tranzakció); az ütemezés külön, azonnal ható művelet
 * (PUT/DELETE …/schedule — ugyanaz a végpont és szabályrendszer, mint a
 * Gantt-é). Szándékosan nem egy gombra kötve: két külön tranzakció lenne,
 * és egy félresikerült második lépés félig mentett állapotot hagyna.
 */
export default function WorkOrderDrawer({
  target,
  machines,
  canEdit,
  onClose,
  onSaved,
}: {
  target: WorkOrderTarget;
  /** Aktív gépek — az ütemezéshez. */
  machines: Machine[];
  canEdit: boolean;
  onClose: () => void;
  /** A frissített rendelés. "created" után a szülő szerkesztő módba vált (ütemezéshez), "saved" után bezár, "scheduled" és "materials" után nyitva marad. */
  onSaved: (wo: WorkOrder, kind: "created" | "saved" | "scheduled" | "materials") => void;
}) {
  const creating = target.mode === "create";
  const source = target.mode === "edit" ? target.workOrder : target.copyOf;
  const [initial] = useState(() => toDraft(source, target.mode === "create"));
  const [draft, setDraft] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<{ message: string; field?: string } | null>(null);
  const [instructions, setInstructions] = useState<WorkInstruction[] | null>(null);
  const [preview, setPreview] = useState<WorkInstruction | null>(null);

  useEffect(() => {
    let alive = true;
    listInstructions()
      .then((rows) => alive && setInstructions(rows))
      .catch(() => alive && setInstructions([]));
    return () => {
      alive = false;
    };
  }, []);

  // What the terminal will show for the draft as it stands now.
  const shownInstruction = instructionForOrder(instructions ?? [], { partName: draft.partName, workInstructionName: draft.workInstructionName || null });
  const instructionHint =
    instructions === null ? (
      "Loading…"
    ) : shownInstruction ? (
      <>
        {draft.workInstructionName === "" ? `Named like the part: “${shownInstruction.partName}”, ` : ""}v{shownInstruction.version}
        {shownInstruction.pdfFileId ? ", with PDF" : ""}.{" "}
        <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={() => setPreview(shownInstruction)}>
          Preview
        </button>
      </>
    ) : draft.partName.trim() === "" ? (
      "Automatic: the instruction named like the part."
    ) : (
      `No instruction is named “${draft.partName.trim()}”: the terminal shows none. Choose one, or create it under Quality → Work instructions.`
    );

  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  const errors = localErrors(draft, creating);
  const fieldError = (f: string) => (touched ? errors[f] : undefined) ?? (serverError?.field === f ? serverError.message : undefined);
  const terminal = !creating && (target.workOrder.status === "completed" || target.workOrder.status === "cancelled");

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    if (serverError) setServerError(null);
  }

  function requestClose() {
    if (saving) return;
    if (preview) return setPreview(null);
    if (canEdit && changed && !window.confirm(creating ? "Discard this new work order?" : "Discard unsaved changes?")) return;
    onClose();
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0 || !canEdit) return;
    setSaving(true);
    setServerError(null);
    try {
      const payload = toPayload(draft);
      let res: Response;
      if (creating) {
        res = await apiFetch(`${API_BASE}/api/work-orders`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderNumber: draft.orderNumber.trim(), ...payload }),
        });
      } else {
        const before = toPayload(initial);
        const diff = Object.fromEntries(Object.entries(payload).filter(([k, v]) => before[k] !== v));
        if (Object.keys(diff).length === 0) return onClose();
        res = await apiFetch(`${API_BASE}/api/work-orders/${encodeURIComponent(target.workOrder.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(diff),
        });
      }
      onSaved(await readJsonOrThrow<WorkOrder>(res), creating ? "created" : "saved");
    } catch (err) {
      setServerError(err instanceof ApiError ? { message: err.message, field: err.field } : { message: String(err) });
    } finally {
      setSaving(false);
    }
  }

  const title = creating ? (target.copyOf ? `Copy of ${target.copyOf.orderNumber}` : "New work order") : target.workOrder.orderNumber;
  const formId = "work-order-form";

  return (
    <Drawer
      title={title}
      subtitle={creating ? "Save the order first, then add its material and schedule it on a machine." : target.workOrder.partName}
      onRequestClose={requestClose}
      footer={
        canEdit ? (
          <>
            <span className="ui-field-hint" style={{ flex: 1 }}>
              {!creating && changed ? "Unsaved changes" : ""}
            </span>
            <button type="button" className="ui-btn" onClick={requestClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={saving || (!creating && !changed)}>
              {saving ? "Saving…" : creating ? "Create work order" : "Save changes"}
            </button>
          </>
        ) : (
          <>
            <span className="ui-field-hint" style={{ flex: 1 }}>
              Only admins and managers can change work orders.
            </span>
            <button type="button" className="ui-btn" onClick={onClose}>
              Close
            </button>
          </>
        )
      }
    >
      <form id={formId} onSubmit={save} noValidate>
        <fieldset disabled={!canEdit || saving} style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
          {serverError && !serverError.field && <p className="ui-message ui-message-error">{serverError.message}</p>}

          <section className="ui-section">
            <h3 className="ui-section-title">Order</h3>
            <div className="ui-grid-2">
              {creating && (
                <Field label="Order number" error={fieldError("orderNumber")} hint="Cannot be changed later.">
                  <input className="ui-input" value={draft.orderNumber} onChange={(e) => set("orderNumber", e.target.value)} placeholder="WO-2026-0341" aria-invalid={!!fieldError("orderNumber")} />
                </Field>
              )}
              <Field label="Part" error={fieldError("partName")}>
                <input className="ui-input" value={draft.partName} onChange={(e) => set("partName", e.target.value)} placeholder="Bracket A-12" aria-invalid={!!fieldError("partName")} />
              </Field>
              <Field label="Quantity" error={fieldError("quantity")}>
                <input className="ui-input num" inputMode="numeric" value={draft.quantity} onChange={(e) => set("quantity", e.target.value)} aria-invalid={!!fieldError("quantity")} />
              </Field>
              <Field label="Cycle time (s)" error={fieldError("expectedCycleTimeSeconds")} hint="Empty: the machine's ideal cycle time is used.">
                <input
                  className="ui-input num"
                  inputMode="decimal"
                  value={draft.expectedCycleTimeSeconds}
                  onChange={(e) => set("expectedCycleTimeSeconds", e.target.value)}
                  aria-invalid={!!fieldError("expectedCycleTimeSeconds")}
                />
              </Field>
              <Field label="Due date" error={fieldError("dueDate")}>
                <input className="ui-input" type="date" value={draft.dueDate} onChange={(e) => set("dueDate", e.target.value)} />
              </Field>
              {!creating && (
                <Field label="Status" error={fieldError("status")}>
                  <select className="ui-select" value={draft.status} onChange={(e) => set("status", e.target.value as WorkOrderStatus)}>
                    {(Object.keys(STATUS_LABEL) as WorkOrderStatus[]).map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
            <div style={{ marginTop: 12 }}>
              <Field label="Notes" error={fieldError("notes")}>
                <textarea className="ui-textarea" value={draft.notes} onChange={(e) => set("notes", e.target.value)} />
              </Field>
            </div>
          </section>

          <section className="ui-section">
            <h3 className="ui-section-title">Work instruction</h3>
            <Field label="Shown at the terminal" error={fieldError("workInstructionName")} hint={instructionHint}>
              <select className="ui-select" value={draft.workInstructionName} onChange={(e) => set("workInstructionName", e.target.value)} aria-invalid={!!fieldError("workInstructionName")}>
                <option value="">Automatic (by part name)</option>
                {/* A chosen instruction stays selectable even while the list is loading. */}
                {draft.workInstructionName !== "" && !(instructions ?? []).some((i) => i.partName === draft.workInstructionName) && (
                  <option value={draft.workInstructionName}>{draft.workInstructionName}</option>
                )}
                {(instructions ?? []).map((i) => (
                  <option key={i.partName} value={i.partName}>
                    {i.partName} (v{i.version})
                  </option>
                ))}
              </select>
            </Field>
          </section>

          <section className="ui-section">
            <h3 className="ui-section-title">Completion</h3>
            <div className="ui-grid-2">
              <Field label="Close the order" hint={draft.completionMode === "auto" ? "Closes itself when the good count reaches the quantity." : "The operator confirms completion at the terminal."}>
                <select className="ui-select" value={draft.completionMode} onChange={(e) => set("completionMode", e.target.value as "manual" | "auto")}>
                  <option value="manual">Manually</option>
                  <option value="auto">Automatically at target</option>
                </select>
              </Field>
            </div>
            <label className="ui-check" style={{ marginTop: 12 }}>
              <input type="checkbox" checked={draft.countOverproduction} onChange={(e) => set("countOverproduction", e.target.checked)} />
              Count parts produced beyond the quantity
            </label>
          </section>
        </fieldset>
      </form>

      {!creating && (
        <MaterialsSection
          workOrder={target.workOrder}
          canEdit={canEdit}
          onChanged={() => {
            void apiFetch(`${API_BASE}/api/work-orders/${encodeURIComponent(target.workOrder.id)}`)
              .then((r) => readJsonOrThrow<WorkOrder>(r))
              .then((wo) => onSaved(wo, "materials"));
          }}
        />
      )}

      {!creating && (
        <ScheduleSection
          workOrder={target.workOrder}
          machines={machines}
          canEdit={canEdit && !terminal}
          terminal={terminal}
          onChanged={() => {
            // A gép/időpont a szerveren változott — a friss rendelést kérjük le.
            void apiFetch(`${API_BASE}/api/work-orders/${encodeURIComponent(target.workOrder.id)}`)
              .then((r) => readJsonOrThrow<WorkOrder>(r))
              .then((wo) => onSaved(wo, "scheduled"));
          }}
        />
      )}
      {preview && <InstructionViewer instruction={preview} subtitle="Preview: what the operator sees" onClose={() => setPreview(null)} />}
    </Drawer>
  );
}

/**
 * A rendeléshez felhasznált alapanyag-tételek. Mint az ütemezés: azonnal ható
 * műveletek (hozzáadás / eltávolítás), nem a "Save changes" gomb része. Lezárt
 * rendelésnél is szerkeszthető — a nyomonkövetési adat utólag is javítható, és
 * minden változás az audit naplóba kerül.
 */
function MaterialsSection({ workOrder, canEdit, onChanged }: { workOrder: WorkOrder; canEdit: boolean; onChanged: () => void }) {
  const [lots, setLots] = useState<MaterialLot[] | null>(null);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch(`${API_BASE}/api/material-lots`)
      .then((r) => readJsonOrThrow<MaterialLot[]>(r))
      .then((rows) => alive && setLots(rows))
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, []);

  const used = new Set(workOrder.materials.map((m) => m.materialLotId));
  const available = (lots ?? []).filter((l) => !used.has(l.id));
  const base = `${API_BASE}/api/work-orders/${encodeURIComponent(workOrder.id)}/material-consumption`;

  async function run(request: () => Promise<Response>) {
    setBusy(true);
    setError(null);
    try {
      await readJsonOrThrow<unknown>(await request());
      setChoice("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ui-section">
      <h3 className="ui-section-title">Material</h3>
      {workOrder.materials.length === 0 ? (
        <p className="ui-field-hint" style={{ marginTop: 0 }}>
          No material lot recorded yet. Without it the finished lot cannot be traced back to its material.
        </p>
      ) : (
        <ul className="ui-mini-list">
          {workOrder.materials.map((m) => (
            <li key={m.materialLotId} style={{ alignItems: "center" }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                {m.materialName}
                <span className="ui-sub">Lot {m.lotNumber}</span>
              </span>
              {canEdit && (
                <button
                  type="button"
                  className="ui-btn ui-btn-small ui-btn-ghost"
                  disabled={busy}
                  onClick={() => void run(() => apiFetch(`${base}/${encodeURIComponent(m.materialLotId)}`, { method: "DELETE" }))}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <>
          <div className="ui-inline-form">
            <div style={{ flex: 1, minWidth: 200 }}>
              <Field label="Material lot">
                <select className="ui-select" value={choice} onChange={(e) => setChoice(e.target.value)} disabled={busy || lots === null}>
                  <option value="">{lots === null ? "Loading…" : available.length === 0 ? "No other material lots" : "Choose a material lot…"}</option>
                  {available.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.materialName} · lot {l.lotNumber}
                      {l.supplier ? ` · ${l.supplier}` : ""}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <button
              type="button"
              className="ui-btn"
              disabled={busy || choice === ""}
              onClick={() =>
                void run(() =>
                  apiFetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ materialLotId: choice }) }),
                )
              }
            >
              {busy ? "Saving…" : "Add"}
            </button>
          </div>
          <p className="ui-field-hint" style={{ margin: "8px 0 0" }}>
            A delivery that is not in the list is registered under{" "}
            <a href="/production/materials" target="_blank" rel="noopener noreferrer">
              Production → Material lots
            </a>
            .
          </p>
        </>
      )}
      {error && (
        <p className="ui-message ui-message-error" style={{ marginTop: 8 }}>
          {error}
        </p>
      )}
    </section>
  );
}

function ScheduleSection({
  workOrder,
  machines,
  canEdit,
  terminal,
  onChanged,
}: {
  workOrder: WorkOrder;
  machines: Machine[];
  canEdit: boolean;
  terminal: boolean;
  onChanged: () => void;
}) {
  const current = workOrder.schedule;
  const [machineId, setMachineId] = useState(current?.machineId ?? machines[0]?.id ?? "");
  const [start, setStart] = useState(toLocalInput(current?.plannedStart ?? null));
  const [mode, setMode] = useState<"duration" | "end">("duration");
  const [end, setEnd] = useState(toLocalInput(current?.plannedEnd ?? null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const machine = machines.find((m) => m.id === machineId);
  const required = requiredSeconds(workOrder, machine);
  const inProgress = workOrder.status === "in_progress";
  const canUnschedule = current !== null && (workOrder.status === "planned" || workOrder.status === "released");

  async function send(method: "PUT" | "DELETE", body?: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/work-orders/${encodeURIComponent(workOrder.id)}/schedule`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      await readJsonOrThrow<unknown>(res);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function schedule() {
    const plannedStart = fromLocalInput(start);
    if (!machineId || !plannedStart) return setError("Choose a machine and a start time.");
    if (mode === "duration") {
      if (!required) return setError("Enter a cycle time on the order (or an ideal cycle time on the machine), or schedule until an end time.");
      void send("PUT", { machineId, plannedStart, durationMs: Math.round(required * 1000) });
    } else {
      const plannedEnd = fromLocalInput(end);
      if (!plannedEnd) return setError("Choose an end time.");
      void send("PUT", { machineId, plannedStart, plannedEnd });
    }
  }

  const lateFor = current && workOrder.dueDate && new Date(current.plannedEnd).getTime() > endOfDay(workOrder.dueDate);
  const short = current && required && current.plannedSeconds < required;

  return (
    <section className="ui-section">
      <h3 className="ui-section-title">Schedule</h3>
      {current ? (
        <dl className="ui-facts">
          <dt>Machine</dt>
          <dd>{current.machineName}</dd>
          <dt>Planned</dt>
          <dd>
            {formatDateTime(current.plannedStart)} – {formatDateTime(current.plannedEnd)}
          </dd>
          <dt>Working time</dt>
          <dd>
            {formatDuration(current.plannedSeconds)}
            {current.segments > 1 ? ` in ${current.segments} blocks (split around off-shift time)` : ""}
            {short ? <span className="ui-pill ui-pill-warning" style={{ marginLeft: 8 }}>{formatDuration(required)} needed</span> : null}
          </dd>
          {lateFor && (
            <>
              <dt>Due</dt>
              <dd>
                <span className="ui-pill ui-pill-warning">Finishes after the due date</span>
              </dd>
            </>
          )}
        </dl>
      ) : (
        <p className="ui-field-hint" style={{ marginTop: 0 }}>
          Not scheduled yet. It will appear on the Gantt chart once scheduled.
        </p>
      )}

      {terminal ? (
        <p className="ui-field-hint">Completed and cancelled orders can't be rescheduled.</p>
      ) : canEdit ? (
        <>
          <div className="ui-grid-2">
            <Field label="Machine" hint={inProgress ? "A running order stays on its machine." : undefined}>
              <select className="ui-select" value={machineId} onChange={(e) => setMachineId(e.target.value)} disabled={busy || inProgress}>
                {machines.length === 0 && <option value="">No active machines</option>}
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Start">
              <input className="ui-input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} disabled={busy} />
            </Field>
          </div>
          <div className="ui-radio-row" role="radiogroup" aria-label="Length">
            <label className="ui-check">
              <input type="radio" checked={mode === "duration"} onChange={() => setMode("duration")} disabled={busy} />
              Working time from cycle time{required ? ` (${formatDuration(required)})` : ""}
            </label>
            <label className="ui-check">
              <input type="radio" checked={mode === "end"} onChange={() => setMode("end")} disabled={busy} />
              Until a fixed end
            </label>
          </div>
          {mode === "end" && (
            <div className="ui-grid-2" style={{ marginBottom: 8 }}>
              <Field label="End">
                <input className="ui-input" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} disabled={busy} />
              </Field>
            </div>
          )}
          <p className="ui-field-hint" style={{ margin: "0 0 8px" }}>
            Off-shift time is skipped automatically, so the order may be split into several blocks.
          </p>
          {error && <p className="ui-message ui-message-error">{error}</p>}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="ui-btn ui-btn-primary" onClick={schedule} disabled={busy || machines.length === 0}>
              {busy ? "Saving…" : current ? "Reschedule" : "Schedule"}
            </button>
            {canUnschedule && (
              <button type="button" className="ui-btn ui-btn-danger" onClick={() => void send("DELETE")} disabled={busy}>
                Unschedule
              </button>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
