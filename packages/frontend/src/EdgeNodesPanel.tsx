import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { useAuth } from "./auth-context.js";
import { ApiError } from "./master-data.js";
import {
  FIELDS,
  PROTOCOLS,
  addChannel as createChannel,
  api as call,
  channelPatchBody,
  describeConnection,
  emptyChannelForm,
  fetchEdgeNodes,
  formFromChannel,
  protocolLabel,
  toNumber,
  updateChannel,
  type ChannelForm,
  type EdgeNode,
  type EdgeNodeChannel,
  type SignalSource,
  type StatusMode,
} from "./edge-channels.js";

interface Machine {
  id: string;
  name: string;
}

const inputStyle = { padding: 6, border: "1px solid #e1e0d9", borderRadius: 6 };
const buttonStyle = {
  padding: "6px 12px",
  border: "1px solid #0b0b0b",
  borderRadius: 6,
  background: "#0b0b0b",
  color: "#fff",
  cursor: "pointer",
  fontSize: 13,
};
const secondaryButtonStyle = { ...buttonStyle, background: "#fff", color: "#0b0b0b" };
const dangerButtonStyle = { ...secondaryButtonStyle, color: "#d03b3b", borderColor: "#d03b3b" };
const hintStyle = { fontSize: 11, color: "#898781" };

// --------------------------------------------------------------- form pieces

function ChannelFormFields(props: {
  form: ChannelForm;
  setForm: Dispatch<SetStateAction<ChannelForm>>;
  machines: Machine[];
  canChangeProtocol: boolean;
  errorField?: string;
}) {
  const { form, setForm, machines, canChangeProtocol, errorField } = props;
  const setConfig = (key: string, value: string) =>
    setForm((f) => ({ ...f, config: { ...f.config, [key]: value } }));
  const fieldStyle = (key: string, width: number) => ({
    ...inputStyle,
    width,
    borderColor: errorField === `connectionConfig.${key}` ? "#d03b3b" : "#e1e0d9",
  });

  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ fontSize: 12 }}>
          Machine<br />
          <select
            value={form.machineId}
            onChange={(e) => setForm((f) => ({ ...f, machineId: e.target.value }))}
            style={{ ...inputStyle, borderColor: errorField === "machineId" ? "#d03b3b" : "#e1e0d9" }}
          >
            <option value="">unassigned</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>
          Protocol<br />
          {canChangeProtocol ? (
            <select
              value={form.signalSource}
              onChange={(e) => setForm((f) => ({ ...f, signalSource: e.target.value as SignalSource, config: {} }))}
              style={inputStyle}
            >
              {PROTOCOLS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          ) : (
            <span style={{ display: "inline-block", padding: "6px 0", fontWeight: 600 }}>{protocolLabel(form.signalSource)}</span>
          )}
        </label>
        <label style={{ fontSize: 12 }}>
          Status mode<br />
          <select
            value={form.statusMode}
            onChange={(e) => setForm((f) => ({ ...f, statusMode: e.target.value as StatusMode }))}
            style={inputStyle}
          >
            <option value="status_bit">Dedicated status bit</option>
            <option value="signal_presence">Signal presence</option>
          </select>
        </label>
        {form.statusMode === "signal_presence" ? (
          <label style={{ fontSize: 12 }}>
            No-signal timeout (s)<br />
            <input
              type="number"
              value={form.noSignalTimeoutSeconds}
              onChange={(e) => setForm((f) => ({ ...f, noSignalTimeoutSeconds: e.target.value }))}
              style={{ ...inputStyle, width: 90, borderColor: errorField === "noSignalTimeoutSeconds" ? "#d03b3b" : "#e1e0d9" }}
            />
          </label>
        ) : (
          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="checkbox"
              checked={form.acceptProductionWhileDown}
              onChange={(e) => setForm((f) => ({ ...f, acceptProductionWhileDown: e.target.checked }))}
            />
            Accept production while down
          </label>
        )}
      </div>

      {FIELDS[form.signalSource].length > 0 && (
        <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {FIELDS[form.signalSource].map((f) => (
            <label key={f.key} style={{ fontSize: 12 }}>
              {f.label}<br />
              <input
                placeholder={f.placeholder}
                value={form.config[f.key] ?? ""}
                onChange={(e) => setConfig(f.key, e.target.value)}
                style={fieldStyle(f.key, f.width)}
              />
            </label>
          ))}
        </div>
      )}
    </>
  );
}

function NodeSettings(props: { node: EdgeNode; onSaved: () => void }) {
  const { node, onSaved } = props;
  const saved = node.settings?.catchupMaxMinutes ?? 10;
  const [minutes, setMinutes] = useState(String(saved));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = minutes !== String(saved);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await call(`/api/edge-nodes/${encodeURIComponent(node.id)}/settings`, "PATCH", {
        catchupMaxMinutes: toNumber(minutes),
      });
      setMessage({ ok: true, text: "Saved. The edge node applies it the next time its agent starts." });
      onSaved();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} style={{ marginTop: 10, paddingLeft: 26, display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
      <label style={{ fontSize: 12 }}>
        Catch-up limit (minutes)<br />
        <input
          type="number"
          min={0}
          max={1440}
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          style={{ ...inputStyle, width: 90 }}
        />
      </label>
      <button type="submit" disabled={busy || !dirty} style={{ ...buttonStyle, opacity: busy || !dirty ? 0.5 : 1 }}>
        {busy ? "Saving…" : "Save"}
      </button>
      <div style={{ ...hintStyle, maxWidth: 520 }}>
        Parts made while the agent was stopped or could not reach the machine are booked afterwards, if the gap is not longer than this.
        Longer gaps are dropped (and logged). 0 = off. Default 10.
      </div>
      {message && <div style={{ fontSize: 12, color: message.ok ? "#0ca30c" : "#d03b3b", width: "100%" }}>{message.text}</div>}
    </form>
  );
}

// --------------------------------------------------------------------- panel

export default function EdgeNodesPanel() {
  const { auth } = useAuth();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [nodes, setNodes] = useState<EdgeNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);
  const [newNodeName, setNewNodeName] = useState("");
  const [addingChannelFor, setAddingChannelFor] = useState<string | null>(null);
  const [editingChannel, setEditingChannel] = useState<string | null>(null);
  const [channelForm, setChannelForm] = useState<ChannelForm>(emptyChannelForm());
  const [formError, setFormError] = useState<{ message: string; field?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isAdmin = auth?.role === "admin" || auth?.role === "manager";

  function load() {
    Promise.all([
      call<Machine[]>("/api/machine-registry?active=true", "GET"),
      fetchEdgeNodes(),
    ])
      .then(([m, n]) => {
        setMachines(m);
        setNodes(n);
        setError(null);
      })
      .catch((err) => setError(String(err instanceof Error ? err.message : err)));
  }

  useEffect(load, []);

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  async function createNode(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const body = await call<{ name: string; token: string }>("/api/edge-nodes", "POST", { name: newNodeName.trim() });
      setNewToken({ name: body.name, token: body.token });
      setNewNodeName("");
      load();
    } catch (err) {
      fail(err);
    } finally {
      setSubmitting(false);
    }
  }

  async function removeNode(node: EdgeNode) {
    const what = node.channels.length > 0 ? ` and its ${node.channels.length} channel(s)` : "";
    if (!window.confirm(`Remove edge node "${node.name}"${what}? The device stops collecting data until it is set up again.`)) return;
    try {
      await call(`/api/edge-nodes/${encodeURIComponent(node.id)}`, "DELETE");
      load();
    } catch (err) {
      fail(err);
    }
  }

  async function regenerateToken(node: EdgeNode) {
    if (!window.confirm(`Create a new token for "${node.name}"? The old token stops working at once; the device must be given the new one.`)) return;
    try {
      const body = await call<{ token: string }>(`/api/edge-nodes/${encodeURIComponent(node.id)}/regenerate-token`, "POST");
      setNewToken({ name: node.name, token: body.token });
    } catch (err) {
      fail(err);
    }
  }

  async function addChannel(edgeNodeId: string, e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await createChannel(edgeNodeId, channelForm);
      setChannelForm(emptyChannelForm());
      setAddingChannelFor(null);
      load();
    } catch (err) {
      setFormError({ message: err instanceof Error ? err.message : String(err), field: err instanceof ApiError ? err.field : undefined });
    } finally {
      setSubmitting(false);
    }
  }

  async function saveChannel(channelId: string, e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await updateChannel(channelId, channelPatchBody(channelForm));
      setEditingChannel(null);
      load();
    } catch (err) {
      setFormError({ message: err instanceof Error ? err.message : String(err), field: err instanceof ApiError ? err.field : undefined });
    } finally {
      setSubmitting(false);
    }
  }

  async function removeChannel(c: EdgeNodeChannel) {
    if (!window.confirm(`Remove the ${protocolLabel(c.signalSource)} channel of "${c.machineName ?? "unassigned"}"? Data collection for it stops when the node restarts.`)) return;
    try {
      await call(`/api/edge-node-channels/${encodeURIComponent(c.id)}`, "DELETE");
      load();
    } catch (err) {
      fail(err);
    }
  }

  function startAdd(nodeId: string) {
    setChannelForm(emptyChannelForm());
    setFormError(null);
    setEditingChannel(null);
    setAddingChannelFor(nodeId);
  }

  function startEdit(c: EdgeNodeChannel) {
    setChannelForm(formFromChannel(c));
    setFormError(null);
    setAddingChannelFor(null);
    setEditingChannel(c.id);
  }

  if (!isAdmin) return null;

  const formErrorLine = formError && (
    <div style={{ color: "#d03b3b", fontSize: 12, marginTop: 8 }}>{formError.message}</div>
  );

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Edge nodes</h2>
      <p style={hintStyle}>
        An edge node is a physical device with its own token, and can serve any number of machines (channels).
        Channel and node settings are applied when the node's agent starts, so restart the agent after a change.
      </p>

      {newToken && (
        <div style={{ border: "1px solid #eda100", background: "#fffaf0", borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Token for "{newToken.name}" — copy it now, it won't be shown again:</div>
          <code style={{ display: "block", background: "#fff", padding: 8, borderRadius: 6, fontSize: 13, wordBreak: "break-all" }}>
            {newToken.token}
          </code>
          <button style={{ ...secondaryButtonStyle, marginTop: 8 }} onClick={() => setNewToken(null)}>
            Dismiss
          </button>
        </div>
      )}

      <form onSubmit={createNode} style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 16 }}>
        <label style={{ fontSize: 12 }}>
          New edge node name<br />
          <input required value={newNodeName} onChange={(e) => setNewNodeName(e.target.value)} placeholder="Line 3 industrial PC" style={inputStyle} />
        </label>
        <button type="submit" disabled={submitting} style={buttonStyle}>
          {submitting ? "Creating…" : "Create edge node"}
        </button>
      </form>

      {error && <p style={{ color: "#d03b3b", fontSize: 13 }}>{error}</p>}

      {nodes.map((n) => (
        <div key={n.id} style={{ border: "1px solid #e1e0d9", borderRadius: 10, padding: 12, marginTop: 8 }}>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <span
              style={{ width: 10, height: 10, borderRadius: "50%", background: n.isOnline ? "#0ca30c" : "#d03b3b", display: "inline-block" }}
              title={n.isOnline ? "online" : "offline"}
            />
            <div style={{ fontWeight: 600 }}>{n.name}</div>
            <div style={hintStyle}>
              last seen: {(n.lastSeenAt ?? n.lastHeartbeatAt) ? new Date((n.lastSeenAt ?? n.lastHeartbeatAt) as string).toLocaleString() : "never"}
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button style={secondaryButtonStyle} onClick={() => regenerateToken(n)}>
                New token
              </button>
              <button style={dangerButtonStyle} onClick={() => removeNode(n)}>
                Remove node
              </button>
            </div>
          </div>

          <NodeSettings key={`${n.id}-${n.settings?.catchupMaxMinutes ?? 10}`} node={n} onSaved={load} />

          <div style={{ marginTop: 10, paddingLeft: 26 }}>
            {n.channels.map((c) =>
              editingChannel === c.id ? (
                <form
                  key={c.id}
                  onSubmit={(e) => saveChannel(c.id, e)}
                  style={{ marginTop: 6, padding: 10, background: "#f7f7f5", borderRadius: 8 }}
                >
                  <ChannelFormFields
                    form={channelForm}
                    setForm={setChannelForm}
                    machines={machines}
                    canChangeProtocol={false}
                    errorField={formError?.field}
                  />
                  {formErrorLine}
                  <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
                    <button type="submit" disabled={submitting} style={buttonStyle}>
                      {submitting ? "Saving…" : "Save channel"}
                    </button>
                    <button type="button" style={secondaryButtonStyle} onClick={() => setEditingChannel(null)}>
                      Cancel
                    </button>
                    <span style={hintStyle}>Applied when the node's agent restarts. The protocol cannot be changed; add a new channel instead.</span>
                  </div>
                </form>
              ) : (
                <div key={c.id} style={{ display: "flex", gap: 16, alignItems: "center", fontSize: 13, padding: "6px 0", borderTop: "1px solid #f0efeb" }}>
                  <span>📡</span>
                  <div style={{ minWidth: 120 }}>{c.machineName ?? "unassigned"}</div>
                  <div style={{ color: "#898781" }}>{protocolLabel(c.signalSource)} · {c.statusMode}</div>
                  <div style={{ color: "#898781", fontSize: 12 }}>{describeConnection(c)}</div>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    <button style={{ ...secondaryButtonStyle, padding: "3px 8px", fontSize: 11 }} onClick={() => startEdit(c)}>
                      Edit
                    </button>
                    <button style={{ ...dangerButtonStyle, padding: "3px 8px", fontSize: 11 }} onClick={() => removeChannel(c)}>
                      Remove
                    </button>
                  </div>
                </div>
              ),
            )}

            {addingChannelFor === n.id ? (
              <form onSubmit={(e) => addChannel(n.id, e)} style={{ marginTop: 10, padding: 10, background: "#f7f7f5", borderRadius: 8 }}>
                <ChannelFormFields
                  form={channelForm}
                  setForm={setChannelForm}
                  machines={machines}
                  canChangeProtocol
                  errorField={formError?.field}
                />
                {formErrorLine}
                <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                  <button type="submit" disabled={submitting} style={buttonStyle}>
                    {submitting ? "Adding…" : "Add channel"}
                  </button>
                  <button type="button" style={secondaryButtonStyle} onClick={() => setAddingChannelFor(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button style={{ ...secondaryButtonStyle, marginTop: 8, fontSize: 12 }} onClick={() => startAdd(n.id)}>
                + Add channel (machine)
              </button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}
