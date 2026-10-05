import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Field from "./ui/Field.js";
import { ApiError } from "./master-data.js";
import {
  FIELDS,
  PROTOCOLS,
  addChannel,
  channelPatchBody,
  describeConnection,
  emptyChannelForm,
  fetchEdgeNodes,
  formFromChannel,
  protocolLabel,
  updateChannel,
  type ChannelForm,
  type EdgeNode,
  type EdgeNodeChannel,
  type SignalSource,
  type StatusMode,
} from "./edge-channels.js";

type Mode = { kind: "edit"; channelId: string } | { kind: "add" } | null;
type Located = { node: EdgeNode; channel: EdgeNodeChannel };

const rowStyle = { display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" as const, padding: "8px 0", borderTop: "1px solid #f0efeb" };

/**
 * "Data source" part of the machine editor: which edge node channel feeds this
 * machine, with edit / assign / add / unassign. It saves on its own (its own
 * buttons), independently of the machine form above it, and sits outside that
 * <form> (forms cannot be nested).
 */
export default function MachineDataSourceSection({ machineId }: { machineId: string }) {
  const [nodes, setNodes] = useState<EdgeNode[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [form, setForm] = useState<ChannelForm>(emptyChannelForm(machineId));
  const [addNodeId, setAddNodeId] = useState("");
  const [assignId, setAssignId] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<{ message: string; field?: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchEdgeNodes()
      .then((n) => {
        setNodes(n);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(load, [load]);

  const mine = useMemo<Located[]>(
    () => (nodes ?? []).flatMap((node) => node.channels.filter((c) => c.machineId === machineId).map((channel) => ({ node, channel }))),
    [nodes, machineId],
  );
  const free = useMemo<Located[]>(
    () => (nodes ?? []).flatMap((node) => node.channels.filter((c) => !c.machineId).map((channel) => ({ node, channel }))),
    [nodes],
  );

  const errField = formError?.field;
  const cfgError = (key: string) => (errField === `connectionConfig.${key}` ? formError?.message : undefined);

  async function run(action: () => Promise<unknown>, done: () => void, okNote?: string) {
    setBusy(true);
    setFormError(null);
    setNote(null);
    try {
      await action();
      done();
      if (okNote) setNote(okNote);
      load();
    } catch (err) {
      setFormError({ message: err instanceof Error ? err.message : String(err), field: err instanceof ApiError ? err.field : undefined });
    } finally {
      setBusy(false);
    }
  }

  const applied = "Saved. The edge node applies it the next time its agent starts.";

  function startEdit(c: EdgeNodeChannel) {
    setForm(formFromChannel(c));
    setFormError(null);
    setNote(null);
    setMode({ kind: "edit", channelId: c.id });
  }

  function startAdd() {
    setForm(emptyChannelForm(machineId));
    setAddNodeId(nodes?.[0]?.id ?? "");
    setFormError(null);
    setNote(null);
    setMode({ kind: "add" });
  }

  function saveEdit(e: FormEvent, channelId: string) {
    e.preventDefault();
    void run(() => updateChannel(channelId, channelPatchBody({ ...form, machineId })), () => setMode(null), applied);
  }

  function saveAdd(e: FormEvent) {
    e.preventDefault();
    if (!addNodeId) {
      setFormError({ message: "Choose an edge node." });
      return;
    }
    void run(() => addChannel(addNodeId, { ...form, machineId }), () => setMode(null), applied);
  }

  function assign() {
    if (!assignId) return;
    void run(() => updateChannel(assignId, { machineId }), () => setAssignId(""), "Assigned. The edge node applies it the next time its agent starts.");
  }

  function unassign({ node, channel }: Located) {
    if (!window.confirm(`Disconnect ${protocolLabel(channel.signalSource)} (${describeConnection(channel)}) from this machine? The channel stays on ${node.name}, unassigned.`)) return;
    void run(() => updateChannel(channel.id, { machineId: null }), () => undefined, "Disconnected. The edge node applies it the next time its agent starts.");
  }

  const set = (patch: Partial<ChannelForm>) => setForm((f) => ({ ...f, ...patch }));
  const setCfg = (key: string, value: string) => setForm((f) => ({ ...f, config: { ...f.config, [key]: value } }));

  const formFields = (canPickProtocol: boolean) => (
    <>
      <div className="ui-grid-2">
        <Field label="Protocol">
          {canPickProtocol ? (
            <select className="ui-select" value={form.signalSource} onChange={(e) => set({ signalSource: e.target.value as SignalSource, config: {} })}>
              {PROTOCOLS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          ) : (
            <span style={{ display: "inline-block", padding: "6px 0", fontWeight: 600 }}>{protocolLabel(form.signalSource)}</span>
          )}
        </Field>
        <Field label="Status mode">
          <select className="ui-select" value={form.statusMode} onChange={(e) => set({ statusMode: e.target.value as StatusMode })}>
            <option value="status_bit">Dedicated status bit</option>
            <option value="signal_presence">Signal presence</option>
          </select>
        </Field>
        {FIELDS[form.signalSource].map((f) => (
          <Field key={f.key} label={f.label} error={cfgError(f.key)}>
            <input
              className="ui-input"
              placeholder={f.placeholder}
              value={form.config[f.key] ?? ""}
              onChange={(e) => setCfg(f.key, e.target.value)}
              aria-invalid={!!cfgError(f.key)}
            />
          </Field>
        ))}
        {form.statusMode === "signal_presence" && (
          <Field label="No-signal timeout (s)" error={errField === "noSignalTimeoutSeconds" ? formError?.message : undefined}>
            <input className="ui-input num" inputMode="numeric" value={form.noSignalTimeoutSeconds} onChange={(e) => set({ noSignalTimeoutSeconds: e.target.value })} />
          </Field>
        )}
      </div>
      {form.statusMode === "status_bit" && (
        <div style={{ marginTop: 12 }}>
          <label className="ui-check">
            <input type="checkbox" checked={form.acceptProductionWhileDown} onChange={(e) => set({ acceptProductionWhileDown: e.target.checked })} />
            Accept production while down
          </label>
        </div>
      )}
      {formError && (!errField || errField === "machineId") && <p className="ui-message ui-message-error">{formError.message}</p>}
    </>
  );

  return (
    <section className="ui-section">
      <h3 className="ui-section-title">Data source</h3>

      {loadError && <p className="ui-message ui-message-error">{loadError}</p>}
      {!nodes && !loadError && <p className="ui-field-hint">Loading…</p>}

      {nodes && mine.length === 0 && mode?.kind !== "add" && (
        <p className="ui-field-hint">
          No data source is connected to this machine, so it shows no live data. Connect an existing channel or add a new one.
        </p>
      )}

      {mine.map((located) => {
        const { node, channel } = located;
        if (mode?.kind === "edit" && mode.channelId === channel.id) {
          return (
            <form key={channel.id} onSubmit={(e) => saveEdit(e, channel.id)} style={{ padding: "8px 0", borderTop: "1px solid #f0efeb" }}>
              <div className="ui-field-hint" style={{ marginBottom: 8 }}>Edge node: {node.name}</div>
              {formFields(false)}
              <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>{busy ? "Saving…" : "Save connection"}</button>
                <button type="button" className="ui-btn" disabled={busy} onClick={() => setMode(null)}>Cancel</button>
              </div>
            </form>
          );
        }
        return (
          <div key={channel.id} style={rowStyle}>
            <span
              title={node.isOnline ? "edge node online" : "edge node offline"}
              style={{ width: 9, height: 9, borderRadius: "50%", background: node.isOnline ? "#0ca30c" : "#d03b3b", display: "inline-block" }}
            />
            <div>
              <div style={{ fontWeight: 600 }}>{protocolLabel(channel.signalSource)} · {describeConnection(channel)}</div>
              <div className="ui-field-hint">via {node.name}{node.isOnline ? "" : " (offline)"} · {channel.statusMode}</div>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button type="button" className="ui-btn" disabled={busy} onClick={() => startEdit(channel)}>Edit</button>
              <button type="button" className="ui-btn" disabled={busy} onClick={() => unassign(located)}>Disconnect</button>
            </div>
          </div>
        );
      })}

      {nodes && mode?.kind === "add" && (
        <form onSubmit={saveAdd} style={{ padding: "8px 0", borderTop: "1px solid #f0efeb" }}>
          <div className="ui-grid-2" style={{ marginBottom: 12 }}>
            <Field label="Edge node" hint="The device that reads this machine.">
              <select className="ui-select" value={addNodeId} onChange={(e) => setAddNodeId(e.target.value)}>
                {nodes.length === 0 && <option value="">No edge nodes yet</option>}
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>{n.name}{n.isOnline ? "" : " (offline)"}</option>
                ))}
              </select>
            </Field>
          </div>
          {formFields(true)}
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button type="submit" className="ui-btn ui-btn-primary" disabled={busy || nodes.length === 0}>{busy ? "Adding…" : "Add data source"}</button>
            <button type="button" className="ui-btn" disabled={busy} onClick={() => setMode(null)}>Cancel</button>
          </div>
        </form>
      )}

      {nodes && !mode && (
        <div style={{ ...rowStyle, borderTop: mine.length ? "1px solid #f0efeb" : "none" }}>
          {free.length > 0 && (
            <>
              <select className="ui-select" aria-label="Unassigned channel" value={assignId} onChange={(e) => setAssignId(e.target.value)} style={{ maxWidth: 340 }}>
                <option value="">Connect an unassigned channel…</option>
                {free.map(({ node, channel }) => (
                  <option key={channel.id} value={channel.id}>
                    {node.name} · {protocolLabel(channel.signalSource)} · {describeConnection(channel)}
                  </option>
                ))}
              </select>
              <button type="button" className="ui-btn" disabled={busy || !assignId} onClick={assign}>Connect</button>
            </>
          )}
          <button type="button" className="ui-btn" disabled={busy} onClick={startAdd} style={{ marginLeft: free.length > 0 ? "auto" : 0 }}>
            + Add new data source
          </button>
        </div>
      )}

      {note && <p className="ui-field-hint" style={{ marginTop: 8 }}>{note}</p>}
      {formError && !mode && <p className="ui-message ui-message-error">{formError.message}</p>}
      <p className="ui-field-hint" style={{ marginTop: 8 }}>
        Changes here are saved immediately and apply when the edge node's agent starts. Nodes, tokens and removing channels: Admin → Edge nodes.
      </p>
    </section>
  );
}
