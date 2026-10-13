import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE } from "./api.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import Field from "./ui/Field.js";
import { MODE_LABEL, scrapApi, type ScrapMode, type ScrapReason } from "./scrap.js";

interface Machine {
  id: string;
  name: string;
  isActive: boolean;
}

/**
 * Admin → Scrap reasons: selejtokok, mint a Status definitions — globálisak
 * (minden gépre) és gépenkéntiek; egy gépen a saját, azonos kódú ok felülírja
 * a globálisat. Alatta gépenként: hogyan számít a terminálon lejelentett selejt.
 */
export default function ScrapReasonsPanel() {
  const { can } = useAuth();
  const isAdmin = can("admin.machines");
  const [machines, setMachines] = useState<Machine[]>([]);
  const [reasons, setReasons] = useState<ScrapReason[]>([]);
  const [modes, setModes] = useState<{ machineId: string; machineName: string; mode: ScrapMode; isActive: boolean }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ machineId: "", code: "", name: "" });
  const [busy, setBusy] = useState(false);

  function load() {
    Promise.all([apiFetch(`${API_BASE}/api/machine-registry`).then((r) => r.json()), scrapApi.reasons(), scrapApi.modes()])
      .then(([m, r, md]) => {
        setMachines(m);
        setReasons(r);
        setModes(md);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }
  useEffect(load, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await scrapApi.createReason({ machineId: form.machineId || undefined, code: form.code.trim(), name: form.name.trim() });
      setForm({ machineId: form.machineId, code: "", name: "" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function setActive(r: ScrapReason, isActive: boolean) {
    setReasons((list) => list.map((x) => (x.id === r.id ? { ...x, isActive } : x)));
    try {
      await scrapApi.updateReason(r.id, { isActive });
    } catch (err) {
      setReasons((list) => list.map((x) => (x.id === r.id ? r : x)));
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function setMode(machineId: string, mode: ScrapMode) {
    const before = modes;
    setModes((list) => list.map((x) => (x.machineId === machineId ? { ...x, mode } : x)));
    try {
      await scrapApi.setMode(machineId, mode);
    } catch (err) {
      setModes(before);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!isAdmin) return null;
  const machineName = (id: string | null) => (id ? (machines.find((m) => m.id === id)?.name ?? id) : "All machines (global default)");

  const columns: Column<ScrapReason>[] = [
    { id: "code", header: "Code", sortValue: (r) => r.code, cell: (r) => <span className="num">{r.code}</span> },
    { id: "name", header: "Name", sortValue: (r) => r.name, cell: (r) => r.name },
    { id: "scope", header: "Applies to", sortValue: (r) => machineName(r.machineId), cell: (r) => machineName(r.machineId) },
    {
      id: "active",
      header: "Offered at the terminal",
      sortValue: (r) => (r.isActive ? 1 : 0),
      cell: (r) => (
        <label className="ui-check">
          <input type="checkbox" checked={r.isActive} onChange={(e) => setActive(r, e.target.checked)} aria-label={`${r.code} offered at the terminal`} />
          {r.isActive ? "Yes" : "No"}
        </label>
      ),
    },
  ];

  return (
    <>
      <section className="ui-panel" style={{ marginTop: 8 }}>
        <div className="ui-panel-head">
          <h2 className="ui-panel-title">Scrap reasons</h2>
          <span className="ui-panel-count num">{reasons.length}</span>
        </div>
        <p className="ui-field-hint" style={{ marginTop: 0 }}>
          The reasons a worker chooses at the terminal when reporting scrap. A global reason applies to every machine; a machine's own reason with the same code replaces it there. The
          machine's own scrap signal can carry a reason code too. A reason in use can be switched off instead of removed; reports keep the name they were booked with.
        </p>
        <form onSubmit={add} className="ui-inline-form" style={{ marginBottom: 12 }}>
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
            <input className="ui-input" required value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} placeholder="BURR" />
          </Field>
          <Field label="Name (shown at the terminal)">
            <input className="ui-input" required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Sorja" />
          </Field>
          <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>
            {busy ? "Adding…" : "Add reason"}
          </button>
        </form>
        {error && <p className="ui-message ui-message-error">{error}</p>}
        <DataTable
          ariaLabel="Scrap reasons"
          rows={reasons}
          columns={columns}
          getRowId={(r) => r.id}
          initialSort={{ columnId: "code", dir: "asc" }}
          rowActions={(r) => (
            <button
              type="button"
              className="ui-btn ui-btn-small ui-btn-danger"
              onClick={() => window.confirm(`Remove scrap reason ${r.code}? Reports booked with it keep its name.`) && scrapApi.deleteReason(r.id).then(load, (err) => setError(String(err)))}
            >
              Remove
            </button>
          )}
          emptyText="No scrap reasons yet. Add the common ones as global reasons (e.g. BURR Sorja, DIM Méreten kívül, SURF Felületi hiba)."
        />
      </section>

      <section className="ui-panel" style={{ marginTop: 12 }}>
        <div className="ui-panel-head">
          <h2 className="ui-panel-title">How reported scrap counts, by machine</h2>
        </div>
        <p className="ui-field-hint" style={{ marginTop: 0 }}>
          <strong>Taken off the good parts</strong>: the machine counts every part as good; scrap reported at the terminal moves that many parts from good to scrap (the total stays).{" "}
          <strong>Added as extra scrap</strong>: the machine already tells good from scrap, or the parts were scrapped outside its counter; the report adds scrap parts, good stays.
        </p>
        <DataTable
          ariaLabel="Scrap counting by machine"
          rows={modes}
          columns={[
            { id: "machine", header: "Machine", sortValue: (m) => m.machineName, cell: (m) => (m.isActive ? m.machineName : <span className="ui-sub">{m.machineName} (inactive)</span>) },
            {
              id: "mode",
              header: "Reported scrap",
              cell: (m) => (
                <select className="ui-select" value={m.mode} onChange={(e) => setMode(m.machineId, e.target.value as ScrapMode)} aria-label={`${m.machineName} scrap counting`}>
                  {(Object.keys(MODE_LABEL) as ScrapMode[]).map((k) => (
                    <option key={k} value={k}>
                      {MODE_LABEL[k]}
                    </option>
                  ))}
                </select>
              ),
            },
          ]}
          getRowId={(m) => m.machineId}
          initialSort={{ columnId: "machine", dir: "asc" }}
          emptyText="No machines."
        />
      </section>
    </>
  );
}
