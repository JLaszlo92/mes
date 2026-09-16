import { useEffect, useRef, useState } from "react";
import type { MachineEvent, MachineStatusValue } from "@mes/shared";
import ShiftSummaryPanel from "./ShiftSummaryPanel.js";
import MachineRegistryPanel from "./MachineRegistryPanel.js";
import { useAuth } from "./auth-context.js";
import LoginForm from "./LoginForm.js";
import AuditLogPanel from "./AuditLogPanel";
import WorkOrdersPanel from "./WorkOrdersPanel";
import SchedulePanel from "./SchedulePanel";
import TerminalUisPanel from "./TerminalUisPanel";
import MfaSetup from "./MfaSetup.js";
import AlertsPanel from "./AlertsPanel.js";

interface MachineState {
  machineId: string;
  status: MachineStatusValue;
  goodCount: number;
  scrapCount: number;
  lastUpdated: string;
}

type ServerMessage =
  | { type: "snapshot"; machines: MachineState[] }
  | { type: "event"; event: MachineEvent };

const WS_URL = import.meta.env.VITE_BACKEND_WS_URL ?? "ws://localhost:3001/ws";

const STATUS_COLOR: Record<MachineStatusValue, string> = {
  running: "#0ca30c",
  idle: "#898781",
  down: "#d03b3b",
  changeover: "#eda100",
};

function applyEventToMachines(
  machines: Record<string, MachineState>,
  event: MachineEvent,
): Record<string, MachineState> {
  const existing =
    machines[event.machineId] ??
    ({
      machineId: event.machineId,
      status: "idle",
      goodCount: 0,
      scrapCount: 0,
      lastUpdated: event.timestamp,
    } satisfies MachineState);

  const updated: MachineState = { ...existing, lastUpdated: event.timestamp };
  if (event.type === "machine_status") {
    updated.status = event.status;
  } else if (event.type === "production_count") {
    if (event.result === "good") updated.goodCount += 1;
    else updated.scrapCount += 1;
  }
  return { ...machines, [event.machineId]: updated };
}

export default function App() {
  const [machines, setMachines] = useState<Record<string, MachineState>>({});
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  const { auth, logout, mfaSetupRequired } = useAuth();


  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;

    function connect() {
      const socket = new WebSocket(WS_URL);
      socketRef.current = socket;

      socket.onopen = () => setConnected(true);

      socket.onmessage = (raw) => {
        const message = JSON.parse(raw.data) as ServerMessage;
        if (message.type === "snapshot") {
          const byId = Object.fromEntries(message.machines.map((m) => [m.machineId, m]));
          setMachines(byId);
        } else {
          setMachines((prev) => applyEventToMachines(prev, message.event));
        }
      };

      socket.onclose = () => {
        setConnected(false);
        if (!cancelled) retryTimer = setTimeout(connect, 2000);
      };
    }

    connect();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      socketRef.current?.close();
    };
  }, []);

  if (mfaSetupRequired) {
    return <MfaSetup />;
  }
  
  if (!auth) {
    return <LoginForm />;
  }
  
  const machineList = Object.values(machines).sort((a, b) =>
    a.machineId.localeCompare(b.machineId),
  );

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "40px auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ fontSize: 20 }}>MES — Walking Skeleton Dashboard</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, color: "#898781" }}>{auth.role}</span>
          <button
            onClick={logout}
            style={{ fontSize: 13, padding: "4px 10px", border: "1px solid #e1e0d9", borderRadius: 6, background: "#fff", cursor: "pointer" }}
          >
            Sign out
          </button>
          <span style={{ fontSize: 13, color: connected ? "#0ca30c" : "#d03b3b" }}>
            {connected ? "● live" : "○ disconnected — retrying…"}
          </span>
        </div>
      </header>
      <p style={{ color: "#666", fontSize: 13 }}>
        M0 acceptance view: proves one machine's signal flows edge → cloud → screen, and
        recovers automatically after a connection drop. See ROADMAP.md.
      </p>

      {machineList.length === 0 && (
        <p style={{ color: "#898781" }}>Waiting for the first event from the edge agent…</p>
      )}

      {machineList.map((m) => (
        <div
          key={m.machineId}
          style={{
            border: "1px solid #e1e0d9",
            borderRadius: 10,
            padding: 16,
            marginTop: 12,
            display: "flex",
            alignItems: "center",
            gap: 20,
          }}
        >
          <div>
            <div style={{ fontSize: 13, color: "#898781" }}>Machine</div>
            <div style={{ fontWeight: 600 }}>{m.machineId}</div>
          </div>
          <div>
            <div style={{ fontSize: 13, color: "#898781" }}>Status</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: "50%",
                  background: STATUS_COLOR[m.status],
                  display: "inline-block",
                }}
              />
              {m.status}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 13, color: "#898781" }}>Good</div>
            <div style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{m.goodCount}</div>
          </div>
          <div>
            <div style={{ fontSize: 13, color: "#898781" }}>Scrap</div>
            <div style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{m.scrapCount}</div>
          </div>
          <div>
            <div style={{ fontSize: 13, color: "#898781" }}>Last update</div>
            <div style={{ fontSize: 13 }}>{new Date(m.lastUpdated).toLocaleTimeString()}</div>
          </div>
        </div>
      ))}
      <ShiftSummaryPanel />
      <MachineRegistryPanel />
      <WorkOrdersPanel />
      <SchedulePanel />
      <TerminalUisPanel />
      <AuditLogPanel />
      <AlertsPanel />
    </div>
  );
}
