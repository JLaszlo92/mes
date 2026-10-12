import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE } from "./api.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import Drawer from "./ui/Drawer.js";
import { formatDateTime } from "./ui/format.js";
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
  pairedAt: string | null;
  lastSeenAt: string | null;
}

interface Pairing {
  ui: TerminalUi;
  url: string;
  qrCodeDataUrl: string;
}

export default function TerminalUisPanel() {
  const { auth, logout } = useAuth();
  const [uis, setUis] = useState<TerminalUi[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [selectedMachineIds, setSelectedMachineIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [pairBusy, setPairBusy] = useState(false);

  async function pair(ui: TerminalUi) {
    if (ui.pairedAt && !window.confirm(`Pair a new device with ${ui.name}? The device paired now stops working at once.`)) return;
    setPairBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/terminal-uis/${encodeURIComponent(ui.id)}/pair`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      setPairing({ ui, url: body.url, qrCodeDataUrl: body.qrCodeDataUrl });
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setPairBusy(false);
    }
  }

  async function unpair(ui: TerminalUi) {
    if (!window.confirm(`Unpair ${ui.name}? Its screen shows "not paired" until a device is paired again.`)) return;
    const res = await apiFetch(`${API_BASE}/api/terminal-uis/${encodeURIComponent(ui.id)}/pair`, { method: "DELETE" });
    if (!res.ok) setError(`Unpair failed (${res.status})`);
    load();
  }

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
      id: "device",
      header: "Device",
      sortValue: (ui) => ui.pairedAt,
      cell: (ui) =>
        ui.pairedAt ? (
          <span>
            Paired {formatDateTime(ui.pairedAt)}
            <span className="ui-sub">{ui.lastSeenAt ? `last seen ${formatDateTime(ui.lastSeenAt)}` : "not opened yet"}</span>
          </span>
        ) : (
          <span className="ui-pill ui-pill-warning">Not paired</span>
        ),
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
          <>
          <button type="button" className="ui-btn ui-btn-small" disabled={pairBusy} onClick={() => void pair(ui)}>
            {ui.pairedAt ? "Pair a new device" : "Pair device"}
          </button>
          {ui.pairedAt && (
            <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={() => void unpair(ui)}>
              Unpair
            </button>
          )}
          <button type="button" className="ui-btn ui-btn-small ui-btn-danger" onClick={() => window.confirm(`Remove terminal UI ${ui.name}? Its kiosk address stops working.`) && void remove(ui.id)}>
            Remove
          </button>
          </>
        )}
        emptyText="No terminal UIs yet."
      />

      {pairing && (
        <Drawer
          title={`Pair a device with ${pairing.ui.name}`}
          subtitle="Do this once on the tablet at the machine."
          onRequestClose={() => setPairing(null)}
          footer={
            <>
              <span style={{ flex: 1 }} />
              <button type="button" className="ui-btn ui-btn-primary" onClick={() => setPairing(null)}>
                Done
              </button>
            </>
          }
        >
          <section className="ui-section">
            <ol style={{ margin: "0 0 12px", paddingLeft: 20, lineHeight: 1.6 }}>
              <li>On the terminal's tablet, scan this QR code or open the link below.</li>
              <li>The tablet remembers it: no sign-in is needed, also after a restart.</li>
              <li>Workers then use their own 5-digit code for every change at the terminal.</li>
            </ol>
            <img src={pairing.qrCodeDataUrl} alt="Pairing QR code" width={220} height={220} style={{ display: "block", margin: "0 auto 12px" }} />
            <input className="ui-input" readOnly value={pairing.url} onFocus={(e) => e.target.select()} aria-label="Pairing link" style={{ width: "100%" }} />
            <p className="ui-field-hint">
              The link works for one device: anyone who opens it can show this terminal, so do not share it. Pairing again or Unpair disconnects the device
              paired before. The tablet's browser must trust the server's certificate.
            </p>
          </section>
        </Drawer>
      )}
    </section>
  );
}
