import { useEffect, useState, type FormEvent } from "react";
import Drawer from "./ui/Drawer.js";
import Field from "./ui/Field.js";
import { apiFetch, API_BASE } from "./api.js";
import { ApiError, readJsonOrThrow, type Machine } from "./master-data.js";
import { formatDateTime, formatDuration, fromLocalInput, toLocalInput } from "./ui/format.js";

export type MaintenanceStatus = "open" | "assigned" | "in_progress" | "closed";
export type MaintenancePriority = "low" | "normal" | "high" | "urgent";

export const MAINTENANCE_STATUS_LABEL: Record<MaintenanceStatus, string> = {
  open: "Open",
  assigned: "Assigned",
  in_progress: "In progress",
  closed: "Closed",
};
export const PRIORITY_LABEL: Record<MaintenancePriority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
export const SOURCE_LABEL: Record<string, string> = {
  alert: "From an alert",
  fault_report: "From a fault report",
  preventive_schedule: "Preventive schedule",
  manual: "Manual",
};

export interface MaintenanceWorkOrder {
  id: string;
  machineId: string;
  machineName: string;
  title: string;
  description: string | null;
  status: MaintenanceStatus;
  priority: MaintenancePriority;
  assignedTo: string | null;
  assignedToEmail: string | null;
  createdByEmail: string | null;
  sourceType: string | null;
  sourceId: string | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  laborHours: number;
  partsCount: number;
  createdAt: string;
  closedAt: string | null;
}

export interface AssignableUser {
  id: string;
  email: string;
  role: string;
}

export type MaintenanceTarget = { mode: "edit"; order: MaintenanceWorkOrder } | { mode: "create" };

interface Draft {
  machineId: string;
  title: string;
  description: string;
  priority: MaintenancePriority;
  status: MaintenanceStatus;
  assignedTo: string;
  plannedStart: string;
  plannedEnd: string;
}

function toDraft(o: MaintenanceWorkOrder | undefined, machines: Machine[]): Draft {
  return {
    machineId: o?.machineId ?? machines[0]?.id ?? "",
    title: o?.title ?? "",
    description: o?.description ?? "",
    priority: o?.priority ?? "normal",
    status: o?.status ?? "open",
    assignedTo: o?.assignedTo ?? "",
    plannedStart: toLocalInput(o?.plannedStart),
    plannedEnd: toLocalInput(o?.plannedEnd),
  };
}

function toPayload(d: Draft): Record<string, unknown> {
  return {
    machineId: d.machineId,
    title: d.title.trim(),
    description: d.description.trim() === "" ? null : d.description,
    priority: d.priority,
    status: d.status,
    assignedTo: d.assignedTo || null,
    plannedStart: fromLocalInput(d.plannedStart),
    plannedEnd: fromLocalInput(d.plannedEnd),
  };
}

function localErrors(d: Draft): Record<string, string> {
  const e: Record<string, string> = {};
  if (!d.machineId) e.machineId = "Choose a machine.";
  if (d.title.trim() === "") e.title = "Describe the job.";
  const s = fromLocalInput(d.plannedStart);
  const en = fromLocalInput(d.plannedEnd);
  if (!!s !== !!en) e[s ? "plannedEnd" : "plannedStart"] = "Set both start and end, or neither.";
  else if (s && en && new Date(en) <= new Date(s)) e.plannedEnd = "The end must be after the start.";
  return e;
}

/**
 * Karbantartási munkarendelés: adatok, felelős, tervezett ablak (a Gantt-hoz
 * előkészítve) — egy mentéssel, egy tranzakcióban. Az alkatrész- és
 * munkaóra-napló azonnal rögzül (naplóbejegyzés, nem az űrlap része).
 */
export default function MaintenanceDrawer({
  target,
  machines,
  users,
  canEdit,
  canLogParts,
  onClose,
  onSaved,
}: {
  target: MaintenanceTarget;
  /** Aktív gépek; szerkesztésnél a rendelés saját gépe is, ha azóta deaktiválták. */
  machines: Machine[];
  users: AssignableUser[];
  canEdit: boolean;
  canLogParts: boolean;
  onClose: () => void;
  onSaved: (order: MaintenanceWorkOrder, kind: "created" | "saved" | "logged") => void;
}) {
  const creating = target.mode === "create";
  const order = target.mode === "edit" ? target.order : undefined;
  const [initial] = useState(() => toDraft(order, machines));
  const [draft, setDraft] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<{ message: string; field?: string } | null>(null);

  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  const errors = localErrors(draft);
  const fieldError = (f: string) => (touched ? errors[f] : undefined) ?? (serverError?.field === f ? serverError.message : undefined);
  const closed = order?.status === "closed";

  const machineOptions = order && !machines.some((m) => m.id === order.machineId) ? [{ id: order.machineId, name: `${order.machineName} (deactivated)` }, ...machines] : machines;

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    if (serverError) setServerError(null);
  }

  function requestClose() {
    if (saving) return;
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
        // A státusz a szerveren dől el (felelőssel "assigned", különben "open").
        const body = Object.fromEntries(Object.entries(payload).filter(([k, v]) => v !== null && k !== "status"));
        res = await apiFetch(`${API_BASE}/api/maintenance-work-orders`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, sourceType: "manual" }),
        });
      } else {
        const before = toPayload(initial);
        const diff: Record<string, unknown> = Object.fromEntries(Object.entries(payload).filter(([k, v]) => before[k] !== v));
        // A tervezett ablak csak párban küldhető.
        if ("plannedStart" in diff || "plannedEnd" in diff) {
          diff.plannedStart = payload.plannedStart;
          diff.plannedEnd = payload.plannedEnd;
        }
        if (Object.keys(diff).length === 0) return onClose();
        res = await apiFetch(`${API_BASE}/api/maintenance-work-orders/${encodeURIComponent(order!.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(diff),
        });
      }
      onSaved(await readJsonOrThrow<MaintenanceWorkOrder>(res), creating ? "created" : "saved");
    } catch (err) {
      setServerError(err instanceof ApiError ? { message: err.message, field: err.field } : { message: String(err) });
    } finally {
      setSaving(false);
    }
  }

  const plannedSeconds =
    fromLocalInput(draft.plannedStart) && fromLocalInput(draft.plannedEnd)
      ? (new Date(fromLocalInput(draft.plannedEnd)!).getTime() - new Date(fromLocalInput(draft.plannedStart)!).getTime()) / 1000
      : null;
  const formId = "maintenance-form";

  return (
    <Drawer
      title={creating ? "New maintenance work order" : order!.title}
      subtitle={creating ? undefined : `${order!.machineName}${order!.sourceType ? `, ${SOURCE_LABEL[order!.sourceType] ?? order!.sourceType}` : ""}`}
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
              Only maintenance, managers and admins can change these work orders.
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
            <h3 className="ui-section-title">Job</h3>
            <div className="ui-grid-2">
              <Field label="Machine" error={fieldError("machineId")}>
                <select className="ui-select" value={draft.machineId} onChange={(e) => set("machineId", e.target.value)} disabled={closed}>
                  {machineOptions.length === 0 && <option value="">No active machines</option>}
                  {machineOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Priority" error={fieldError("priority")}>
                <select className="ui-select" value={draft.priority} onChange={(e) => set("priority", e.target.value as MaintenancePriority)}>
                  {(Object.keys(PRIORITY_LABEL) as MaintenancePriority[]).map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY_LABEL[p]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
              <Field label="Title" error={fieldError("title")}>
                <input className="ui-input" value={draft.title} onChange={(e) => set("title", e.target.value)} placeholder="Replace drive belt" aria-invalid={!!fieldError("title")} />
              </Field>
              <Field label="Description" error={fieldError("description")}>
                <textarea className="ui-textarea" value={draft.description} onChange={(e) => set("description", e.target.value)} />
              </Field>
            </div>
          </section>

          <section className="ui-section">
            <h3 className="ui-section-title">Responsibility</h3>
            <div className="ui-grid-2">
              <Field label="Assigned to" error={fieldError("assignedTo")} hint={creating || draft.status === "open" ? "Assigning someone moves an open job to Assigned." : undefined}>
                <select className="ui-select" value={draft.assignedTo} onChange={(e) => set("assignedTo", e.target.value)}>
                  <option value="">Nobody yet</option>
                  {order?.assignedTo && !users.some((u) => u.id === order.assignedTo) && <option value={order.assignedTo}>{order.assignedToEmail ?? "Unknown user"}</option>}
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.email}
                    </option>
                  ))}
                </select>
              </Field>
              {!creating && (
                <Field label="Status" error={fieldError("status")}>
                  <select className="ui-select" value={draft.status} onChange={(e) => set("status", e.target.value as MaintenanceStatus)}>
                    {(Object.keys(MAINTENANCE_STATUS_LABEL) as MaintenanceStatus[]).map((s) => (
                      <option key={s} value={s}>
                        {MAINTENANCE_STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          </section>

          <section className="ui-section">
            <h3 className="ui-section-title">Planned window</h3>
            <div className="ui-grid-2">
              <Field label="Start" error={fieldError("plannedStart")}>
                <input className="ui-input" type="datetime-local" value={draft.plannedStart} onChange={(e) => set("plannedStart", e.target.value)} />
              </Field>
              <Field label="End" error={fieldError("plannedEnd")} hint={plannedSeconds && plannedSeconds > 0 ? formatDuration(plannedSeconds) : undefined}>
                <input className="ui-input" type="datetime-local" value={draft.plannedEnd} onChange={(e) => set("plannedEnd", e.target.value)} />
              </Field>
            </div>
            <p className="ui-field-hint" style={{ margin: "8px 0 0" }}>
              Optional. Planned maintenance will show on the machine's row in the Gantt chart. Unlike production orders it isn't split around off-shift
              time — it can be planned for a weekend or a night.
            </p>
            {(draft.plannedStart || draft.plannedEnd) && canEdit && (
              <button
                type="button"
                className="ui-btn ui-btn-small ui-btn-ghost"
                style={{ marginTop: 6 }}
                onClick={() => setDraft((d) => ({ ...d, plannedStart: "", plannedEnd: "" }))}
              >
                Clear planned window
              </button>
            )}
          </section>
        </fieldset>
      </form>

      {order && <WorkLog order={order} canLogLabor={canEdit} canLogParts={canLogParts} onLogged={() => onSaved(order, "logged")} />}
    </Drawer>
  );
}

interface Part {
  id: string;
  partName: string;
  quantity: number;
  loggedAt: string;
}
interface Labor {
  id: string;
  performedByEmail: string | null;
  hours: number;
  notes: string | null;
  loggedAt: string;
}

function WorkLog({ order, canLogLabor, canLogParts, onLogged }: { order: MaintenanceWorkOrder; canLogLabor: boolean; canLogParts: boolean; onLogged: () => void }) {
  const [parts, setParts] = useState<Part[]>([]);
  const [labor, setLabor] = useState<Labor[]>([]);
  const [part, setPart] = useState({ name: "", quantity: "1" });
  const [hours, setHours] = useState({ hours: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    const base = `${API_BASE}/api/maintenance-work-orders/${encodeURIComponent(order.id)}`;
    Promise.all([
      apiFetch(`${base}/parts`).then((r) => readJsonOrThrow<Part[]>(r)).then(setParts),
      apiFetch(`${base}/labor`).then((r) => readJsonOrThrow<Labor[]>(r)).then(setLabor),
    ]).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }
  useEffect(load, [order.id]);

  async function post(path: "parts" | "labor", body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/maintenance-work-orders/${encodeURIComponent(order.id)}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await readJsonOrThrow<unknown>(res);
      load();
      onLogged();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const totalHours = labor.reduce((a, l) => a + l.hours, 0);

  return (
    <section className="ui-section">
      <h3 className="ui-section-title">Work log</h3>
      {error && <p className="ui-message ui-message-error">{error}</p>}

      <p className="ui-field-label" style={{ margin: "0 0 4px" }}>
        Labor{labor.length > 0 ? `, ${totalHours.toLocaleString()} h in total` : ""}
      </p>
      {labor.length === 0 ? (
        <p className="ui-field-hint" style={{ marginTop: 0 }}>
          No hours logged.
        </p>
      ) : (
        <ul className="ui-mini-list">
          {labor.map((l) => (
            <li key={l.id}>
              <span className="num" style={{ width: 56 }}>
                {l.hours} h
              </span>
              <span style={{ flex: 1 }}>{l.notes ?? <span className="ui-sub">No notes</span>}</span>
              <span className="ui-sub">
                {l.performedByEmail ?? "—"}, {formatDateTime(l.loggedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canLogLabor && (
        <form
          className="ui-inline-form"
          style={{ marginBottom: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            void post("labor", { hours: Number(hours.hours), notes: hours.notes }).then((ok) => ok && setHours({ hours: "", notes: "" }));
          }}
        >
          <input className="ui-input num" style={{ width: 80 }} inputMode="decimal" placeholder="Hours" value={hours.hours} onChange={(e) => setHours({ ...hours, hours: e.target.value })} aria-label="Hours" />
          <input className="ui-input" style={{ flex: 1, minWidth: 160 }} placeholder="What was done" value={hours.notes} onChange={(e) => setHours({ ...hours, notes: e.target.value })} aria-label="Notes" />
          <button type="submit" className="ui-btn" disabled={busy || !(Number(hours.hours) > 0)}>
            Log hours
          </button>
        </form>
      )}

      <p className="ui-field-label" style={{ margin: "0 0 4px" }}>
        Parts used
      </p>
      {parts.length === 0 ? (
        <p className="ui-field-hint" style={{ marginTop: 0 }}>
          No parts logged.
        </p>
      ) : (
        <ul className="ui-mini-list">
          {parts.map((p) => (
            <li key={p.id}>
              <span className="num" style={{ width: 56 }}>
                {p.quantity} ×
              </span>
              <span style={{ flex: 1 }}>{p.partName}</span>
              <span className="ui-sub">{formatDateTime(p.loggedAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {canLogParts && (
        <form
          className="ui-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void post("parts", { partName: part.name, quantity: Number(part.quantity) }).then((ok) => ok && setPart({ name: "", quantity: "1" }));
          }}
        >
          <input className="ui-input num" style={{ width: 64 }} inputMode="numeric" value={part.quantity} onChange={(e) => setPart({ ...part, quantity: e.target.value })} aria-label="Quantity" />
          <input className="ui-input" style={{ flex: 1, minWidth: 160 }} placeholder="Part name or number" value={part.name} onChange={(e) => setPart({ ...part, name: e.target.value })} aria-label="Part" />
          <button type="submit" className="ui-btn" disabled={busy || part.name.trim() === ""}>
            Log part
          </button>
        </form>
      )}
    </section>
  );
}
