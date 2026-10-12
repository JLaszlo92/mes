import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE } from "./api.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import Field from "./ui/Field.js";

interface Machine {
  id: string;
  name: string;
  isActive: boolean;
}

interface StatusDefinition {
  id: string;
  machineId: string | null;
  code: string;
  displayName: string;
  oeeCategory: "counts_as_down" | "excluded";
  color: string | null;
  blocksProduction: boolean;
}

export default function MachineStatusDefinitionsPanel() {
  const { auth, logout, can } = useAuth();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [definitions, setDefinitions] = useState<StatusDefinition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    machineId: "",
    code: "",
    displayName: "",
    oeeCategory: "counts_as_down" as "counts_as_down" | "excluded",
    color: "#898781",
    blocksProduction: false,
  });
  const [savingId, setSavingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isAdmin = can("admin.machines");

  function load() {
    Promise.all([
      apiFetch(`${API_BASE}/api/machine-registry`).then((r) => r.json()),
      apiFetch(`${API_BASE}/api/status-definitions`, { headers: { Authorization: `Bearer ${auth?.token}` } }).then(
        (res) => {
          if (res.status === 401) {
            logout();
            throw new Error("session expired — please sign in again");
          }
          return res.json();
        },
      ),
    ])
      .then(([m, d]) => {
        setMachines(m);
        setDefinitions(d);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }

  useEffect(load, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/status-definitions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify({
          machineId: form.machineId || undefined,
          code: form.code.trim(),
          displayName: form.displayName.trim(),
          oeeCategory: form.oeeCategory,
          color: form.color,
          blocksProduction: form.blocksProduction,
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
      setForm({ machineId: "", code: "", displayName: "", oeeCategory: "counts_as_down", color: "#898781", blocksProduction: false });
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function setBlocks(d: StatusDefinition, blocksProduction: boolean) {
    setSavingId(d.id);
    setError(null);
    // Shown at once; put back if the server refuses.
    setDefinitions((list) => list.map((x) => (x.id === d.id ? { ...x, blocksProduction } : x)));
    try {
      const res = await apiFetch(`${API_BASE}/api/status-definitions/${encodeURIComponent(d.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify({ blocksProduction }),
      });
      if (res.status === 401) {
        logout();
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      }
      const updated: StatusDefinition = await res.json();
      setDefinitions((list) => list.map((x) => (x.id === updated.id ? updated : x)));
    } catch (err) {
      setDefinitions((list) => list.map((x) => (x.id === d.id ? { ...x, blocksProduction: d.blocksProduction } : x)));
      setError(String(err));
    } finally {
      setSavingId(null);
    }
  }

  async function remove(id: string) {
    const res = await apiFetch(`${API_BASE}/api/status-definitions/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${auth?.token}` },
    });
    if (res.status === 401) {
      logout();
      return;
    }
    load();
  }

  if (!isAdmin) return null;

  const machineName = (id: string | null) => (id ? (machines.find((m) => m.id === id)?.name ?? id) : "All machines (global default)");

  const columns: Column<StatusDefinition>[] = [
    {
      id: "code",
      header: "Code",
      sortValue: (d) => d.code,
      cell: (d) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: "50%", background: d.color ?? "#898781", display: "inline-block" }} />
          {d.code}
        </span>
      ),
    },
    { id: "name", header: "Display name", sortValue: (d) => d.displayName, cell: (d) => d.displayName },
    { id: "scope", header: "Applies to", sortValue: (d) => machineName(d.machineId), cell: (d) => machineName(d.machineId) },
    {
      id: "oee",
      header: "OEE",
      sortValue: (d) => d.oeeCategory,
      cell: (d) => (d.oeeCategory === "counts_as_down" ? "Counts as down" : "Excluded (planned)"),
    },
    {
      id: "blocks",
      header: "Blocks production",
      sortValue: (d) => (d.blocksProduction ? 1 : 0),
      cell: (d) =>
        d.code === "off_shift" ? (
          <span className="ui-field-hint">—</span>
        ) : (
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={d.blocksProduction}
              disabled={savingId === d.id}
              onChange={(e) => setBlocks(d, e.target.checked)}
              aria-label={`${d.code} blocks production`}
            />
            {d.blocksProduction ? "Yes — no running, no counting" : "No — first part returns to running"}
          </label>
        ),
    },
  ];

  return (
    <section className="ui-panel" style={{ marginTop: 8 }}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Custom machine statuses</h2>
        <span className="ui-panel-count num">{definitions.length}</span>
      </div>
      <p className="ui-field-hint" style={{ marginTop: 0 }}>
        "running" and "down" are always built in. Add any additional status your machines can report — each one needs an OEE classification.
        <br />
        <strong>Blocks production</strong> applies when the status is set by hand at a terminal: if it blocks, the machine stays in that status
        and parts made meanwhile are not counted until a worker ends it; if not, the first running signal or part puts the machine back to
        running at once.
      </p>

      <form onSubmit={handleSubmit} className="ui-inline-form" style={{ marginBottom: 12 }}>
        <Field label="Machine">
          <select className="ui-select" value={form.machineId} onChange={(e) => setForm((f) => ({ ...f, machineId: e.target.value }))}>
            <option value="">All machines (global default)</option>
            {machines
              .filter((m) => m.isActive)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Code">
          <input className="ui-input" required value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} placeholder="material_wait" />
        </Field>
        <Field label="Display name">
          <input className="ui-input" required value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} placeholder="Material shortage" />
        </Field>
        <Field label="OEE category">
          <select className="ui-select" value={form.oeeCategory} onChange={(e) => setForm((f) => ({ ...f, oeeCategory: e.target.value as "counts_as_down" | "excluded" }))}>
            <option value="counts_as_down">Counts as down (hurts availability)</option>
            <option value="excluded">Excluded (planned — no OEE impact)</option>
          </select>
        </Field>
        <Field label="Color">
          <input type="color" value={form.color} onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))} style={{ width: 50, height: 32, padding: 2, border: "1px solid var(--c-border-strong)", borderRadius: 6 }} />
        </Field>
        <Field label="Blocks production">
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 32 }}>
            <input type="checkbox" checked={form.blocksProduction} onChange={(e) => setForm((f) => ({ ...f, blocksProduction: e.target.checked }))} />
            No running, no counting
          </label>
        </Field>
        <button type="submit" className="ui-btn ui-btn-primary" disabled={submitting}>
          {submitting ? "Adding…" : "Add status"}
        </button>
      </form>

      {error && <p className="ui-message ui-message-error">{error}</p>}

      <DataTable
        ariaLabel="Custom machine statuses"
        rows={definitions}
        columns={columns}
        getRowId={(d) => d.id}
        initialSort={{ columnId: "code", dir: "asc" }}
        rowActions={(d) => (
          <button type="button" className="ui-btn ui-btn-small ui-btn-danger" onClick={() => window.confirm(`Remove status ${d.code}?`) && remove(d.id)}>
            Remove
          </button>
        )}
        emptyText="No custom statuses yet."
      />
    </section>
  );
}
