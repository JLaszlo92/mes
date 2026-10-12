import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE } from "./api.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import Field from "./ui/Field.js";

interface Machine {
  id: string;
  name: string;
}

interface FaultCode {
  id: string;
  machineId: string;
  code: string;
  name: string;
  signalReference: string | null;
  isActive: boolean;
}

export default function MachineFaultCodesPanel() {
  const { auth, logout } = useAuth();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selectedMachineId, setSelectedMachineId] = useState("");
  const [faultCodes, setFaultCodes] = useState<FaultCode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ code: "", name: "", signalReference: "" });
  const [submitting, setSubmitting] = useState(false);

  const isAdmin = auth?.role === "admin" || auth?.role === "manager";

  useEffect(() => {
    apiFetch(`${API_BASE}/api/machine-registry?active=true`)
      .then((r) => r.json())
      .then((data: Machine[]) => {
        setMachines(data);
        if (data.length > 0 && !selectedMachineId) setSelectedMachineId(data[0].id);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadFaultCodes(machineId: string) {
    if (!machineId) return;
    apiFetch(`${API_BASE}/api/fault-codes?machineId=${encodeURIComponent(machineId)}`)
      .then((r) => r.json())
      .then(setFaultCodes)
      .catch((err) => setError(String(err)));
  }

  useEffect(() => {
    loadFaultCodes(selectedMachineId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMachineId]);

  const activeCodes = faultCodes.filter((f) => f.isActive);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/fault-codes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify({
          machineId: selectedMachineId,
          code: form.code.trim(),
          name: form.name.trim(),
          signalReference: form.signalReference.trim() || undefined,
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
      setForm({ code: "", name: "", signalReference: "" });
      loadFaultCodes(selectedMachineId);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(id: string) {
    const res = await apiFetch(`${API_BASE}/api/fault-codes/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${auth?.token}` },
    });
    if (res.status === 401) {
      logout();
      return;
    }
    loadFaultCodes(selectedMachineId);
  }

  if (!isAdmin) return null;

  const columns: Column<FaultCode>[] = [
    { id: "code", header: "Code", sortValue: (f) => f.code, cell: (f) => f.code },
    { id: "name", header: "Name", sortValue: (f) => f.name, cell: (f) => f.name },
    { id: "signal", header: "Signal reference", sortValue: (f) => f.signalReference, cell: (f) => f.signalReference ?? <span className="ui-sub">—</span> },
  ];

  return (
    <section className="ui-panel" style={{ marginTop: 8 }}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Machine fault codes</h2>
        <span className="ui-panel-count num">{activeCodes.length} / 10</span>
      </div>

      <div className="ui-toolbar">
        <select className="ui-select" value={selectedMachineId} onChange={(e) => setSelectedMachineId(e.target.value)} aria-label="Machine">
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <span className="ui-field-hint">Up to 10 codes per machine — they become the reason buttons at the terminal.</span>
      </div>

      <form onSubmit={handleSubmit} className="ui-inline-form" style={{ marginBottom: 12 }}>
        <Field label="Code">
          <input className="ui-input" required value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} placeholder="E01" style={{ width: 90 }} />
        </Field>
        <Field label="Name">
          <input className="ui-input" required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Sensor jam" />
        </Field>
        <Field label="Signal reference (optional)">
          <input className="ui-input" value={form.signalReference} onChange={(e) => setForm((f) => ({ ...f, signalReference: e.target.value }))} placeholder="S7 DB1.DBX2.3" />
        </Field>
        <button type="submit" className="ui-btn ui-btn-primary" disabled={submitting || activeCodes.length >= 10 || !selectedMachineId}>
          {submitting ? "Adding…" : "Add code"}
        </button>
      </form>

      {error && <p className="ui-message ui-message-error">{error}</p>}

      <DataTable
        ariaLabel="Fault codes"
        paging={{ resetKey: [selectedMachineId] }}
        rows={activeCodes}
        columns={columns}
        getRowId={(f) => f.id}
        initialSort={{ columnId: "code", dir: "asc" }}
        rowActions={(f) => (
          <button type="button" className="ui-btn ui-btn-small ui-btn-danger" onClick={() => window.confirm(`Remove fault code ${f.code}?`) && void remove(f.id)}>
            Remove
          </button>
        )}
        emptyText="No fault codes for this machine yet."
      />
    </section>
  );
}
