import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";

interface Machine {
  id: string;
  name: string;
}

interface EdgeNodeChannel {
  id: string;
  machineId: string | null;
  machineName: string | null;
  signalSource: "simulated" | "gpio" | "s7" | "opcua" | "modbus";
  statusMode: "status_bit" | "signal_presence";
}

interface EdgeNode {
  id: string;
  name: string;
  isOnline: boolean;
  lastHeartbeatAt: string | null;
  channels: EdgeNodeChannel[];
}

const WS_URL = import.meta.env.VITE_BACKEND_WS_URL ?? "ws://localhost:3001/ws";
const API_BASE = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");

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

const emptyConfig = {
  host: "",
  port: "",
  unitId: "",
  goodCountRegister: "",
  scrapCountRegister: "",
  statusRegister: "",
  endpointUrl: "",
  goodCountNodeId: "",
  scrapCountNodeId: "",
  statusNodeId: "",
  plcIp: "",
  plcRack: "",
  plcSlot: "",
  plcPort: "",
  goodPin: "",
  scrapPin: "",
  statusPin: "",
};

function emptyChannelForm() {
  return {
    machineId: "",
    signalSource: "modbus" as EdgeNodeChannel["signalSource"],
    statusMode: "status_bit" as "status_bit" | "signal_presence",
    noSignalTimeoutSeconds: "60",
    acceptProductionWhileDown: true,
    config: { ...emptyConfig },
  };
}

export default function EdgeNodesPanel() {
  const { auth, logout } = useAuth();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [nodes, setNodes] = useState<EdgeNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);
  const [newNodeName, setNewNodeName] = useState("");
  const [addingChannelFor, setAddingChannelFor] = useState<string | null>(null);
  const [channelForm, setChannelForm] = useState(emptyChannelForm());
  const [submitting, setSubmitting] = useState(false);

  const isAdmin = auth?.role === "admin" || auth?.role === "manager";

  function load() {
    Promise.all([
      fetch(`${API_BASE}/api/machine-registry`).then((r) => r.json()),
      fetch(`${API_BASE}/api/edge-nodes`, { headers: { Authorization: `Bearer ${auth?.token}` } }).then((res) => {
        if (res.status === 401) {
          logout();
          throw new Error("session expired — please sign in again");
        }
        return res.json();
      }),
    ])
      .then(([m, n]) => {
        setMachines(m);
        setNodes(n);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }

  useEffect(load, []);

  async function createNode(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/edge-nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify({ name: newNodeName.trim() }),
      });
      if (res.status === 401) {
        logout();
        throw new Error("session expired — please sign in again");
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      }
      const body = await res.json();
      setNewToken({ name: body.name, token: body.token });
      setNewNodeName("");
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function removeNode(id: string) {
    const res = await fetch(`${API_BASE}/api/edge-nodes/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${auth?.token}` },
    });
    if (res.status === 401) {
      logout();
      return;
    }
    load();
  }

  async function regenerateToken(id: string, name: string) {
    const res = await fetch(`${API_BASE}/api/edge-nodes/${encodeURIComponent(id)}/regenerate-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth?.token}` },
    });
    if (res.status === 401) {
      logout();
      return;
    }
    if (res.ok) {
      const body = await res.json();
      setNewToken({ name, token: body.token });
    }
  }

  function buildConnectionConfig(): Record<string, unknown> {
    const c = channelForm.config;
    switch (channelForm.signalSource) {
      case "modbus":
        return {
          host: c.host,
          port: c.port ? Number(c.port) : undefined,
          unitId: c.unitId ? Number(c.unitId) : undefined,
          goodCountRegister: c.goodCountRegister ? Number(c.goodCountRegister) : undefined,
          scrapCountRegister: c.scrapCountRegister ? Number(c.scrapCountRegister) : undefined,
          statusRegister: c.statusRegister ? Number(c.statusRegister) : undefined,
        };
      case "opcua":
        return {
          endpointUrl: c.endpointUrl,
          goodCountNodeId: c.goodCountNodeId,
          scrapCountNodeId: c.scrapCountNodeId,
          statusNodeId: c.statusNodeId,
        };
      case "s7":
        return {
          plcIp: c.plcIp,
          plcRack: c.plcRack ? Number(c.plcRack) : undefined,
          plcSlot: c.plcSlot ? Number(c.plcSlot) : undefined,
          plcPort: c.plcPort ? Number(c.plcPort) : undefined,
        };
      case "gpio":
        return { goodPin: c.goodPin, scrapPin: c.scrapPin, statusPin: c.statusPin };
      default:
        return {};
    }
  }

  async function addChannel(edgeNodeId: string, e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/edge-nodes/${encodeURIComponent(edgeNodeId)}/channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify({
          machineId: channelForm.machineId || undefined,
          signalSource: channelForm.signalSource,
          connectionConfig: buildConnectionConfig(),
          statusMode: channelForm.statusMode,
          noSignalTimeoutSeconds: Number(channelForm.noSignalTimeoutSeconds) || 60,
          acceptProductionWhileDown: channelForm.acceptProductionWhileDown,
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
      setChannelForm(emptyChannelForm());
      setAddingChannelFor(null);
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function removeChannel(channelId: string) {
    const res = await fetch(`${API_BASE}/api/edge-node-channels/${encodeURIComponent(channelId)}`, {
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

  const setConfig = (field: string, value: string) =>
    setChannelForm((f) => ({ ...f, config: { ...f.config, [field]: value } }));

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16 }}>Edge nodes</h2>
      <p style={{ fontSize: 12, color: "#898781" }}>
        Egy edge-node egy fizikai eszköz, saját tokennel — tetszőleges számú géphez (csatornához) rendelhető.
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
            <div style={{ fontSize: 11, color: "#898781" }}>
              last seen: {n.lastHeartbeatAt ? new Date(n.lastHeartbeatAt).toLocaleString() : "never"}
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button style={secondaryButtonStyle} onClick={() => regenerateToken(n.id, n.name)}>
                New token
              </button>
              <button style={{ ...secondaryButtonStyle, color: "#d03b3b", borderColor: "#d03b3b" }} onClick={() => removeNode(n.id)}>
                Remove node
              </button>
            </div>
          </div>

          <div style={{ marginTop: 10, paddingLeft: 26 }}>
            {n.channels.map((c) => (
              <div key={c.id} style={{ display: "flex", gap: 16, alignItems: "center", fontSize: 13, padding: "6px 0", borderTop: "1px solid #f0efeb" }}>
                <span>📡</span>
                <div>{c.machineName ?? "unassigned"}</div>
                <div style={{ color: "#898781" }}>{c.signalSource} · {c.statusMode}</div>
                <button
                  style={{ ...secondaryButtonStyle, marginLeft: "auto", padding: "3px 8px", fontSize: 11 }}
                  onClick={() => removeChannel(c.id)}
                >
                  Remove
                </button>
              </div>
            ))}

            {addingChannelFor === n.id ? (
              <form onSubmit={(e) => addChannel(n.id, e)} style={{ marginTop: 10, padding: 10, background: "#f7f7f5", borderRadius: 8 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <label style={{ fontSize: 12 }}>
                    Machine<br />
                    <select value={channelForm.machineId} onChange={(e) => setChannelForm((f) => ({ ...f, machineId: e.target.value }))} style={inputStyle}>
                      <option value="">unassigned</option>
                      {machines.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                  </label>
                  <label style={{ fontSize: 12 }}>
                    Protocol<br />
                    <select
                      value={channelForm.signalSource}
                      onChange={(e) => setChannelForm((f) => ({ ...f, signalSource: e.target.value as EdgeNodeChannel["signalSource"] }))}
                      style={inputStyle}
                    >
                      <option value="modbus">Modbus TCP</option>
                      <option value="opcua">OPC-UA</option>
                      <option value="s7">S7</option>
                      <option value="gpio">GPIO</option>
                      <option value="simulated">Simulated</option>
                    </select>
                  </label>
                  <label style={{ fontSize: 12 }}>
                    Status mode<br />
                    <select
                      value={channelForm.statusMode}
                      onChange={(e) => setChannelForm((f) => ({ ...f, statusMode: e.target.value as "status_bit" | "signal_presence" }))}
                      style={inputStyle}
                    >
                      <option value="status_bit">Dedicated status bit</option>
                      <option value="signal_presence">Signal presence</option>
                    </select>
                  </label>
                  {channelForm.statusMode === "signal_presence" ? (
                    <label style={{ fontSize: 12 }}>
                      No-signal timeout (s)<br />
                      <input
                        type="number"
                        value={channelForm.noSignalTimeoutSeconds}
                        onChange={(e) => setChannelForm((f) => ({ ...f, noSignalTimeoutSeconds: e.target.value }))}
                        style={{ ...inputStyle, width: 80 }}
                      />
                    </label>
                  ) : (
                    <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                      <input
                        type="checkbox"
                        checked={channelForm.acceptProductionWhileDown}
                        onChange={(e) => setChannelForm((f) => ({ ...f, acceptProductionWhileDown: e.target.checked }))}
                      />
                      Accept production while down
                    </label>
                  )}
                </div>

                <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {channelForm.signalSource === "modbus" && (
                    <>
                      <input placeholder="Host" value={channelForm.config.host} onChange={(e) => setConfig("host", e.target.value)} style={inputStyle} />
                      <input placeholder="Port (502)" value={channelForm.config.port} onChange={(e) => setConfig("port", e.target.value)} style={{ ...inputStyle, width: 90 }} />
                      <input placeholder="Unit ID" value={channelForm.config.unitId} onChange={(e) => setConfig("unitId", e.target.value)} style={{ ...inputStyle, width: 80 }} />
                      <input placeholder="Good register" value={channelForm.config.goodCountRegister} onChange={(e) => setConfig("goodCountRegister", e.target.value)} style={{ ...inputStyle, width: 100 }} />
                      <input placeholder="Scrap register" value={channelForm.config.scrapCountRegister} onChange={(e) => setConfig("scrapCountRegister", e.target.value)} style={{ ...inputStyle, width: 100 }} />
                      <input placeholder="Status register" value={channelForm.config.statusRegister} onChange={(e) => setConfig("statusRegister", e.target.value)} style={{ ...inputStyle, width: 100 }} />
                    </>
                  )}
                  {channelForm.signalSource === "opcua" && (
                    <>
                      <input placeholder="Endpoint URL" value={channelForm.config.endpointUrl} onChange={(e) => setConfig("endpointUrl", e.target.value)} style={{ ...inputStyle, width: 220 }} />
                      <input placeholder="Good node ID" value={channelForm.config.goodCountNodeId} onChange={(e) => setConfig("goodCountNodeId", e.target.value)} style={inputStyle} />
                      <input placeholder="Scrap node ID" value={channelForm.config.scrapCountNodeId} onChange={(e) => setConfig("scrapCountNodeId", e.target.value)} style={inputStyle} />
                      <input placeholder="Status node ID" value={channelForm.config.statusNodeId} onChange={(e) => setConfig("statusNodeId", e.target.value)} style={inputStyle} />
                    </>
                  )}
                  {channelForm.signalSource === "s7" && (
                    <>
                      <input placeholder="PLC IP" value={channelForm.config.plcIp} onChange={(e) => setConfig("plcIp", e.target.value)} style={inputStyle} />
                      <input placeholder="Rack" value={channelForm.config.plcRack} onChange={(e) => setConfig("plcRack", e.target.value)} style={{ ...inputStyle, width: 70 }} />
                      <input placeholder="Slot" value={channelForm.config.plcSlot} onChange={(e) => setConfig("plcSlot", e.target.value)} style={{ ...inputStyle, width: 70 }} />
                      <input placeholder="Port (102)" value={channelForm.config.plcPort} onChange={(e) => setConfig("plcPort", e.target.value)} style={{ ...inputStyle, width: 90 }} />
                    </>
                  )}
                  {channelForm.signalSource === "gpio" && (
                    <>
                      <input placeholder="Good pin" value={channelForm.config.goodPin} onChange={(e) => setConfig("goodPin", e.target.value)} style={{ ...inputStyle, width: 90 }} />
                      <input placeholder="Scrap pin" value={channelForm.config.scrapPin} onChange={(e) => setConfig("scrapPin", e.target.value)} style={{ ...inputStyle, width: 90 }} />
                      <input placeholder="Status pin" value={channelForm.config.statusPin} onChange={(e) => setConfig("statusPin", e.target.value)} style={{ ...inputStyle, width: 90 }} />
                    </>
                  )}
                </div>

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
              <button
                style={{ ...secondaryButtonStyle, marginTop: 8, fontSize: 12 }}
                onClick={() => {
                  setChannelForm(emptyChannelForm());
                  setAddingChannelFor(n.id);
                }}
              >
                + Add channel (machine)
              </button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}