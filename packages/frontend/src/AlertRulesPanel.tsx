import { useEffect, useState, type FormEvent } from "react";
import { apiFetch, API_BASE } from "./api.js";
import { useScope } from "./scope.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import Drawer from "./ui/Drawer.js";
import Field from "./ui/Field.js";
import { readJsonOrThrow } from "./master-data.js";

interface AlertRule {
  id: string;
  type: "machine_down" | "scrap_rate";
  machineId: string | null;
  threshold: number;
  notifyRoles: string[];
  isActive: boolean;
}

const ROLES = ["operator", "supervisor", "maintenance", "manager", "admin"];
const RULE_LABEL = { machine_down: "Machine down", scrap_rate: "Scrap rate" } as const;
const UNIT = { machine_down: "min", scrap_rate: "%" } as const;

/** Riasztási szabályok táblázatban; új szabály oldalpanelben. */
export default function AlertRulesPanel() {
  const { machines, isInScope } = useScope();
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  function load() {
    apiFetch(`${API_BASE}/api/alert-rules`)
      .then((r) => readJsonOrThrow<AlertRule[]>(r))
      .then(setRules)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }
  useEffect(load, []);

  async function send(method: "PUT" | "DELETE", rule: AlertRule, body?: Record<string, unknown>) {
    if (method === "DELETE" && !window.confirm("Remove this alert rule? Open alerts it raised stay in the history.")) return;
    try {
      await readJsonOrThrow<unknown>(
        await apiFetch(`${API_BASE}/api/alert-rules/${encodeURIComponent(rule.id)}`, {
          method,
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        }),
      );
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const machineName = (id: string | null) => (id ? machines.find((m) => m.id === id)?.name ?? id : "All machines");
  const visible = rules.filter((r) => isInScope(r.machineId));

  const columns: Column<AlertRule>[] = [
    { id: "type", header: "Rule", sortValue: (r) => r.type, cell: (r) => RULE_LABEL[r.type] ?? r.type },
    { id: "machine", header: "Machine", sortValue: (r) => machineName(r.machineId), cell: (r) => machineName(r.machineId) },
    { id: "threshold", header: "Threshold", align: "right", sortValue: (r) => r.threshold, cell: (r) => `${r.threshold} ${UNIT[r.type] ?? ""}` },
    { id: "notify", header: "Notifies", cell: (r) => r.notifyRoles.join(", ") || "—" },
    { id: "active", header: "Status", sortValue: (r) => (r.isActive ? 0 : 1), cell: (r) => (r.isActive ? "Active" : <span className="ui-pill">Disabled</span>) },
  ];

  return (
    <section className="ui-panel" style={{ marginTop: 8 }}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Alert rules</h2>
        <span className="ui-panel-count num">{visible.length}</span>
        <span className="ui-toolbar-spacer" />
        <button type="button" className="ui-btn ui-btn-primary" onClick={() => setAdding(true)}>
          New rule
        </button>
      </div>
      {error && <p className="ui-message ui-message-error">{error}</p>}
      <DataTable
        ariaLabel="Alert rules"
        rows={visible}
        columns={columns}
        getRowId={(r) => r.id}
        isDimmed={(r) => !r.isActive}
        rowActions={(r) => (
          <>
            <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={() => void send("PUT", r, { isActive: !r.isActive })}>
              {r.isActive ? "Disable" : "Enable"}
            </button>
            <button type="button" className="ui-btn ui-btn-small ui-btn-ghost ui-btn-danger" onClick={() => void send("DELETE", r)}>
              Remove
            </button>
          </>
        )}
        emptyText="No alert rules. Add one to be alerted when a machine stays down or scrap rises."
      />
      {adding && (
        <NewRuleDrawer
          machines={machines.filter((m) => m.isActive)}
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

function NewRuleDrawer({ machines, onClose, onCreated }: { machines: { id: string; name: string }[]; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ type: "machine_down" as AlertRule["type"], machineId: "", threshold: "", notifyRoles: ["supervisor", "manager"] });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const valid = Number(form.threshold) > 0 && form.notifyRoles.length > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/alert-rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: form.type, machineId: form.machineId || undefined, threshold: Number(form.threshold), notifyRoles: form.notifyRoles }),
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
      title="New alert rule"
      onRequestClose={onClose}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="ui-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="rule-form" className="ui-btn ui-btn-primary" disabled={saving || !valid}>
            {saving ? "Saving…" : "Create rule"}
          </button>
        </>
      }
    >
      <form id="rule-form" onSubmit={submit}>
        <section className="ui-section">
          {error && <p className="ui-message ui-message-error">{error}</p>}
          <div className="ui-grid-2">
            <Field label="Alert when">
              <select className="ui-select" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as AlertRule["type"] })}>
                <option value="machine_down">A machine stays down</option>
                <option value="scrap_rate">The scrap rate rises</option>
              </select>
            </Field>
            <Field label={form.type === "machine_down" ? "For longer than (minutes)" : "Above (%)"}>
              <input className="ui-input num" inputMode="decimal" value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} />
            </Field>
            <Field label="Machine">
              <select className="ui-select" value={form.machineId} onChange={(e) => setForm({ ...form, machineId: e.target.value })}>
                <option value="">All machines</option>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <p className="ui-field-label" style={{ margin: "16px 0 6px" }}>
            Notify
          </p>
          <div className="ui-radio-row" style={{ margin: 0 }}>
            {ROLES.map((role) => (
              <label key={role} className="ui-check">
                <input
                  type="checkbox"
                  checked={form.notifyRoles.includes(role)}
                  onChange={() =>
                    setForm((f) => ({ ...f, notifyRoles: f.notifyRoles.includes(role) ? f.notifyRoles.filter((r) => r !== role) : [...f.notifyRoles, role] }))
                  }
                />
                {role}
              </label>
            ))}
          </div>
        </section>
      </form>
    </Drawer>
  );
}
