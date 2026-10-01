import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE } from "./api.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import Drawer from "./ui/Drawer.js";
import Field from "./ui/Field.js";
import { formatDateTime } from "./ui/format.js";
import { readJsonOrThrow, useMasterDataVersion, type Machine } from "./master-data.js";

type TriggerType = "calendar" | "usage_hours" | "part_count";

interface PreventiveSchedule {
  id: string;
  machineId: string;
  machineName: string;
  triggerType: TriggerType;
  intervalValue: number;
  description: string;
  lastTriggeredAt: string | null;
  isActive: boolean;
}

const TRIGGER_UNIT: Record<TriggerType, string> = { calendar: "days", usage_hours: "running hours", part_count: "parts produced" };
const TRIGGER_LABEL: Record<TriggerType, string> = { calendar: "Calendar", usage_hours: "Running hours", part_count: "Parts produced" };

/**
 * Megelőző karbantartási ütemezések táblázatban. Ha egy ütemezés esedékes,
 * a háttérfolyamat karbantartási munkarendelést nyit (a fenti táblában
 * "Preventive schedule" forrással); annak lezárása indítja újra a számlálót.
 */
export default function PreventiveSchedulesPanel() {
  const { auth } = useAuth();
  const canManage = auth?.role === "maintenance" || auth?.role === "manager" || auth?.role === "admin";
  const version = useMasterDataVersion();
  const [schedules, setSchedules] = useState<PreventiveSchedule[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  function load() {
    Promise.all([
      apiFetch(`${API_BASE}/api/preventive-schedules`).then((r) => readJsonOrThrow<PreventiveSchedule[]>(r)).then(setSchedules),
      apiFetch(`${API_BASE}/api/machine-registry?active=true`).then((r) => readJsonOrThrow<Machine[]>(r)).then(setMachines),
    ])
      .then(() => setError(null))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }
  useEffect(() => {
    if (canManage) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, canManage]);

  const rows = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return schedules.filter((s) => s.isActive && words.every((w) => `${s.description} ${s.machineName}`.toLowerCase().includes(w)));
  }, [schedules, query]);

  async function remove(s: PreventiveSchedule) {
    if (!window.confirm(`Stop the schedule "${s.description}" on ${s.machineName}? No new work orders will be created from it.`)) return;
    try {
      await readJsonOrThrow<unknown>(await apiFetch(`${API_BASE}/api/preventive-schedules/${encodeURIComponent(s.id)}`, { method: "DELETE" }));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!canManage) return null;

  const columns: Column<PreventiveSchedule>[] = [
    { id: "task", header: "Task", sortValue: (s) => s.description, cell: (s) => s.description },
    { id: "machine", header: "Machine", sortValue: (s) => s.machineName, cell: (s) => s.machineName },
    { id: "trigger", header: "Trigger", sortValue: (s) => TRIGGER_LABEL[s.triggerType], cell: (s) => TRIGGER_LABEL[s.triggerType] },
    {
      id: "every",
      header: "Every",
      align: "right",
      sortValue: (s) => s.intervalValue,
      cell: (s) => `${s.intervalValue.toLocaleString()} ${TRIGGER_UNIT[s.triggerType]}`,
    },
    { id: "last", header: "Last triggered", sortValue: (s) => s.lastTriggeredAt, cell: (s) => (s.lastTriggeredAt ? formatDateTime(s.lastTriggeredAt) : "Never") },
  ];

  return (
    <section className="ui-panel" style={{ marginTop: 8 }}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Preventive schedules</h2>
        <span className="ui-panel-count num">{rows.length}</span>
        <span className="ui-toolbar-spacer" />
        <button type="button" className="ui-btn ui-btn-primary" onClick={() => setAdding(true)} disabled={machines.length === 0}>
          New schedule
        </button>
      </div>
      <div className="ui-toolbar" role="search">
        <input className="ui-input ui-search" type="search" placeholder="Search task or machine…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search schedules" />
      </div>
      {error && <p className="ui-message ui-message-error">{error}</p>}
      <DataTable
        ariaLabel="Preventive schedules"
        rows={rows}
        columns={columns}
        getRowId={(s) => s.id}
        initialSort={{ columnId: "machine", dir: "asc" }}
        rowActions={(s) => (
          <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={() => void remove(s)}>
            Stop
          </button>
        )}
        emptyText="No preventive schedules. Add one to open maintenance work orders automatically by time, running hours or part count."
      />
      {adding && (
        <NewScheduleDrawer
          machines={machines}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            load();
          }}
        />
      )}
    </section>
  );
}

function NewScheduleDrawer({ machines, onClose, onCreated }: { machines: Machine[]; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ machineId: machines[0]?.id ?? "", triggerType: "calendar" as TriggerType, intervalValue: "", description: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const valid = form.machineId && form.description.trim() !== "" && Number(form.intervalValue) > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/preventive-schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, intervalValue: Number(form.intervalValue), description: form.description.trim() }),
      });
      await readJsonOrThrow<unknown>(res);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      title="New preventive schedule"
      onRequestClose={onClose}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="ui-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="pm-form" className="ui-btn ui-btn-primary" disabled={saving || !valid}>
            {saving ? "Saving…" : "Create schedule"}
          </button>
        </>
      }
    >
      <form id="pm-form" onSubmit={submit}>
        <section className="ui-section">
          {error && <p className="ui-message ui-message-error">{error}</p>}
          <div style={{ display: "grid", gap: 12 }}>
            <Field label="Task" hint="Becomes the title of each work order it opens.">
              <input className="ui-input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Change hydraulic oil" />
            </Field>
            <div className="ui-grid-2">
              <Field label="Machine">
                <select className="ui-select" value={form.machineId} onChange={(e) => setForm({ ...form, machineId: e.target.value })}>
                  {machines.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Trigger">
                <select className="ui-select" value={form.triggerType} onChange={(e) => setForm({ ...form, triggerType: e.target.value as TriggerType })}>
                  <option value="calendar">Calendar time</option>
                  <option value="usage_hours">Running hours</option>
                  <option value="part_count">Parts produced</option>
                </select>
              </Field>
              <Field label={`Every (${TRIGGER_UNIT[form.triggerType]})`}>
                <input className="ui-input num" inputMode="numeric" value={form.intervalValue} onChange={(e) => setForm({ ...form, intervalValue: e.target.value })} />
              </Field>
            </div>
          </div>
        </section>
      </form>
    </Drawer>
  );
}
