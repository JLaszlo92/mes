import { useEffect, useRef, useState } from "react";
import type { MachineEvent, MachineStatusValue } from "@mes/shared";
import MachineOverviewPanel from "./MachineOverviewPanel.js";
import MachineRegistryPanel from "./MachineRegistryPanel.js";
import { useAuth } from "./auth-context.js";
import LoginForm from "./LoginForm.js";
import AuditLogPanel from "./AuditLogPanel";
import WorkOrdersPanel from "./WorkOrdersPanel";
import SchedulePanel from "./SchedulePanel";
import TerminalUisPanel from "./TerminalUisPanel";
import MfaSetup from "./MfaSetup.js";
import AlertsPanel from "./AlertsPanel.js";
import MachineFaultCodesPanel from "./MachineFaultCodesPanel";
import FaultReportsPanel from "./FaultReportsPanel";
import MaterialLotsPanel from "./MaterialLotsPanel";
import LotsPanel from "./LotsPanel";
import WorkInstructionsPanel from "./WorkInstructionsPanel.js";
import MaintenanceWorkOrdersPanel from "./MaintenanceWorkOrdersPanel.js";
import PreventiveSchedulesPanel from "./PreventiveSchedulesPanel.js";
import MachineStatusDefinitionsPanel from "./MachineStatusDefinitionsPanel.js";
import EdgeNodesPanel from "./EdgeNodesPanel";
import DowntimePeriodsPanel from "./DowntimePeriodsPanel";
import MachineHistoryPanel from "./MachineHistoryPanel";
import CollapsibleSection from "./CollapsibleSection.js";

interface MachineState {
  machineId: string;
  status: MachineStatusValue;
  lastUpdated: string;
}

type ServerMessage =
  | { type: "snapshot"; machines: MachineState[] }
  | { type: "event"; event: MachineEvent };

const WS_URL = import.meta.env.VITE_BACKEND_WS_URL ?? "ws://localhost:3001/ws";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "production", label: "Production" },
  { id: "quality", label: "Quality" },
  { id: "maintenance", label: "Maintenance" },
  { id: "alerts", label: "Alerts" },
  { id: "admin", label: "Admin" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function applyEventToMachines(
  machines: Record<string, MachineState>,
  event: MachineEvent,
): Record<string, MachineState> {
  const existing =
    machines[event.machineId] ??
    ({ machineId: event.machineId, status: "idle", lastUpdated: event.timestamp } satisfies MachineState);

  const updated: MachineState = { ...existing, lastUpdated: event.timestamp };
  if (event.type === "machine_status") {
    updated.status = event.status;
  }
  return { ...machines, [event.machineId]: updated };
}

export default function App() {
  const [machines, setMachines] = useState<Record<string, MachineState>>({});
  const [connected, setConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("overview");
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

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 900, margin: "40px auto", padding: "0 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ fontSize: 20 }}>MES Dashboard</h1>
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

      <nav style={{ display: "flex", gap: 4, marginTop: 16, borderBottom: "1px solid #e1e0d9" }}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "8px 16px",
              border: "none",
              borderBottom: activeTab === tab.id ? "2px solid #0b0b0b" : "2px solid transparent",
              background: "none",
              fontSize: 14,
              fontWeight: activeTab === tab.id ? 600 : 400,
              color: activeTab === tab.id ? "#0b0b0b" : "#898781",
              cursor: "pointer",
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === "overview" && (
        <div>
          <MachineOverviewPanel liveState={machines} />
          <MachineHistoryPanel />
        </div>
      )}

            {activeTab === "production" && (
        <div>
          <CollapsibleSection title="Work orders" defaultOpen>
            <WorkOrdersPanel />
          </CollapsibleSection>
          <CollapsibleSection title="Scheduling">
            <SchedulePanel />
          </CollapsibleSection>
          <CollapsibleSection title="Traceability (lots & material)">
            <LotsPanel />
            <MaterialLotsPanel />
          </CollapsibleSection>
        </div>
      )}

      {activeTab === "quality" && (
        <div>
          <CollapsibleSection title="Fault codes & reports" defaultOpen>
            <MachineFaultCodesPanel />
            <FaultReportsPanel />
          </CollapsibleSection>
          <CollapsibleSection title="Work instructions">
            <WorkInstructionsPanel />
          </CollapsibleSection>
          <CollapsibleSection title="Downtime">
            <DowntimePeriodsPanel />
          </CollapsibleSection>
        </div>
      )}
      {activeTab === "maintenance" && (
        <div>
          <CollapsibleSection title="Work orders" defaultOpen>
            <MaintenanceWorkOrdersPanel />
          </CollapsibleSection>
          <CollapsibleSection title="Preventive schedules">
            <PreventiveSchedulesPanel />
          </CollapsibleSection>
        </div>
      )}

      {activeTab === "alerts" && (
        <div>
          <AlertsPanel />
        </div>
      )}

      {activeTab === "admin" && (
        <div>
          <CollapsibleSection title="Machines" defaultOpen>
            <MachineRegistryPanel />
            <MachineStatusDefinitionsPanel />
          </CollapsibleSection>
          <CollapsibleSection title="Terminals">
            <TerminalUisPanel />
          </CollapsibleSection>
          <CollapsibleSection title="Edge nodes">
            <EdgeNodesPanel />
          </CollapsibleSection>
          <CollapsibleSection title="Audit log">
            <AuditLogPanel />
          </CollapsibleSection>
        </div>
      )}
    </div>
  );
}