import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE } from "./api.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import Field from "./ui/Field.js";

interface Machine {
  id: string;
  name: string;
}

interface TerminalUi {
  id: string;
  name: string;
  machineIds: string[];
  machineNames: string[];
}

export default function TerminalUisPanel() {
  const { auth, logout } = useAuth();
  const [uis, setUis] = useState<TerminalUi[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [selectedMachineIds, setSelectedMachineIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function load() {
    Promise.all([
      apiFetch(`${API_BASE}/api/terminal-uis`).then((r) => r.json()),
      apiFetch(`${API_BASE}/api/machine-registry?active=true`).then((r) => r.json()),
    ])
      .then(([u, m]) => {
        setUis(u);
        setMachines(m);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }

  useEffect(load, []);

  function toggleMachine(id: string) {
    setSelectedMachineIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/terminal-uis`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify({ name: name.trim(), machineIds: selectedMachineIds }),
      });
      if (res.status === 401) {
        logout();
        throw new Error("session expired — please sign in again");
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      }
      setName("");
      setSelectedMachineIds([]);
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/terminal-uis/${encodeURIComponent(id)}`, {
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
      load();
    } catch (err) {
      setError(String(err));
    }
  }

  const columns: Column<TerminalUi>[] = [
    { id: "name", header: "Name", sortValue: (ui) => ui.name, cell: (ui) => ui.name },
    {
      id: "machines",
      header: "Machines",
      sortValue: (ui) => ui.machineNames.length,
      cell: (ui) => (ui.machineNames.length === 0 ? <span className="ui-sub">—</span> : <span title={ui.machineNames.join(", ")}>{ui.machineNames.join(", ")}</span>),
    },
    {
      id: "url",
      header: "Kiosk address",
      cell: (ui) => (
        <a href={`/terminal/${ui.id}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          /terminal/{ui.id}
        </a>
      ),
    },
  ];

  return (
    <section className="ui-panel" style={{ marginTop: 8 }}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Terminal UIs</h2>
        <span className="ui-panel-count num">{uis.length}</span>
      </div>

      <form onSubmit={handleSubmit} className="ui-inline-form" style={{ marginBottom: 12, alignItems: "flex-start" }}>
        <Field label="Name">
          <input className="ui-input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Line 1 terminal" />
        </Field>
        <fieldset style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
          <legend className="ui-field-label">Machines</legend>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", maxWidth: 640, marginTop: 4 }}>
            {machines.map((m) => (
              <label key={m.id} className="ui-check">
                <input type="checkbox" checked={selectedMachineIds.includes(m.id)} onChange={() => toggleMachine(m.id)} />
                {m.name}
              </label>
            ))}
          </div>
        </fieldset>
        <button type="submit" className="ui-btn ui-btn-primary" disabled={submitting} style={{ alignSelf: "flex-end" }}>
          {submitting ? "Adding…" : "Add terminal UI"}
        </button>
      </form>

      {error && <p className="ui-message ui-message-error">{error}</p>}

      <DataTable
        ariaLabel="Terminal UIs"
        rows={uis}
        columns={columns}
        getRowId={(ui) => ui.id}
        initialSort={{ columnId: "name", dir: "asc" }}
        rowActions={(ui) => (
          <button type="button" className="ui-btn ui-btn-small ui-btn-danger" onClick={() => window.confirm(`Remove terminal UI ${ui.name}? Its kiosk address stops working.`) && void remove(ui.id)}>
            Remove
          </button>
        )}
        emptyText="No terminal UIs yet."
      />
    </section>
  );
}
