import { onAlertsChanged } from "./alerts-live.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MachineEvent, MachineStatusValue } from "@mes/shared";
import MachineOverviewPanel from "./MachineOverviewPanel.js";
import MachineRegistryPanel from "./MachineRegistryPanel.js";
import PlantHierarchyPanel from "./PlantHierarchyPanel.js";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE, WS_URL } from "./api.js";
import LoginForm from "./LoginForm.js";
import AuditLogPanel from "./AuditLogPanel";
import WorkOrdersPanel from "./WorkOrdersPanel";
import TerminalUisPanel from "./TerminalUisPanel";
import MfaSetup from "./MfaSetup.js";
import AlertsPanel from "./AlertsPanel.js";
import AlertHistoryPanel from "./AlertHistoryPanel.js";
import AlertRulesPanel from "./AlertRulesPanel.js";
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
import AppShell, { pathOf, type NavGroup } from "./AppShell.js";
import { navigate, usePath } from "./router.js";
import { ScopeProvider } from "./scope.js";
import ScopeSelector from "./ScopeSelector.js";
import ShiftPatternsPanel from "./ShiftPatternsPanel.js";
import GanttSchedulePanel from "./GanttSchedulePanel";
import DowntimeParetoPanel from "./DowntimeParetoPanel.js";

interface MachineState {
  machineId: string;
  status: MachineStatusValue;
  lastUpdated: string;
}

type ServerMessage =
  | { type: "snapshot"; machines: MachineState[] }
  | { type: "event"; event: MachineEvent };

/** A backend ws-tickets.ts close kódjaival szinkronban tartandó. */
const WS_CLOSE_REAUTH = 4000;

/** Újrapróbálkozás: 2, 4, 8, 16, majd 30 mp-enként — egy tartósan elérhetetlen backendet ne árasszunk el. */
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 30_000;

type Role = "admin" | "manager" | "supervisor" | "maintenance" | "operator" | string;

interface ViewDef {
  id: string;
  label: string;
  /** Ha meg van adva, csak ezek a szerepkörök látják (a backend is ezt kényszeríti ki). */
  roles?: Role[];
}

interface GroupDef extends Omit<NavGroup, "items" | "badge"> {
  roles?: Role[];
  items: ViewDef[];
}

const MANAGERS: Role[] = ["admin", "manager"];

/**
 * A navigáció: modul → nézet. Minden nézet egy URL (/modul/nézet), és egyszerre
 * egy nézet látszik — a korábbi fülek + egymás alatti lenyitható szekciók helyett.
 */
const NAV: GroupDef[] = [
  {
    id: "overview",
    label: "Overview",
    icon: "overview",
    items: [
      { id: "live", label: "Live status" },
      { id: "history", label: "Machine history" },
    ],
  },
  {
    id: "production",
    label: "Production",
    icon: "production",
    items: [
      { id: "work-orders", label: "Work orders" },
      { id: "schedule", label: "Gantt schedule" },
      { id: "lots", label: "Lots" },
      { id: "materials", label: "Material lots" },
    ],
  },
  {
    id: "quality",
    label: "Quality",
    icon: "quality",
    items: [
      { id: "fault-reports", label: "Fault reports" },
      { id: "downtime", label: "Downtime" },
      { id: "work-instructions", label: "Work instructions", roles: MANAGERS },
    ],
  },
  {
    id: "maintenance",
    label: "Maintenance",
    icon: "maintenance",
    items: [
      { id: "work-orders", label: "Work orders" },
      { id: "preventive", label: "Preventive schedules", roles: ["maintenance", "manager", "admin"] },
    ],
  },
  {
    id: "alerts",
    label: "Alerts",
    icon: "alerts",
    items: [
      { id: "all", label: "Active" },
      { id: "history", label: "History" },
      { id: "rules", label: "Rules", roles: MANAGERS },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    icon: "admin",
    roles: MANAGERS,
    items: [
      { id: "machines", label: "Machines" },
      { id: "plant", label: "Sites, areas and lines" },
      { id: "shifts", label: "Shifts and calendars" },
      { id: "statuses", label: "Status definitions" },
      { id: "fault-codes", label: "Fault codes" },
      { id: "terminals", label: "Terminals" },
      { id: "edge-nodes", label: "Edge nodes" },
      { id: "audit-log", label: "Audit log", roles: ["admin"] },
    ],
  },
];

function navForRole(role: Role): NavGroup[] {
  return NAV.filter((g) => !g.roles || g.roles.includes(role))
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.roles || i.roles.includes(role)) }))
    .filter((g) => g.items.length > 0);
}

/** Nyugtázatlan, nyitott riasztások száma az oldalsávhoz — 15 mp-enként frissül, és azonnal, ha az Alerts oldalon nyugtáznak. */
function useOpenAlertCount(enabled: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () =>
      apiFetch(`${API_BASE}/api/alerts`)
        .then((r) => (r.ok ? r.json() : []))
        .then((alerts: { resolvedAt: string | null; acknowledgedAt: string | null }[]) => {
          if (!cancelled) setCount(alerts.filter((a) => !a.resolvedAt && !a.acknowledgedAt).length);
        })
        .catch(() => {});
    void load();
    const timer = setInterval(load, 15_000);
    const unsubscribe = onAlertsChanged(() => void load());
    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubscribe();
    };
  }, [enabled]);
  return count;
}

function renderView(groupId: string, viewId: string, liveState: Record<string, MachineState>) {
  switch (`${groupId}/${viewId}`) {
    case "overview/live":
      return <MachineOverviewPanel liveState={liveState} />;
    case "overview/history":
      return <MachineHistoryPanel />;
    case "production/work-orders":
      return <WorkOrdersPanel />;
    case "production/schedule":
      return <GanttSchedulePanel />;
    case "production/lots":
      return <LotsPanel />;
    case "production/materials":
      return <MaterialLotsPanel />;
    case "quality/fault-reports":
      return <FaultReportsPanel />;
    case "quality/downtime":
      return (
        <>
          <DowntimeParetoPanel />
          <DowntimePeriodsPanel />
        </>
      );
    case "quality/work-instructions":
      return <WorkInstructionsPanel />;
    case "maintenance/work-orders":
      return <MaintenanceWorkOrdersPanel />;
    case "maintenance/preventive":
      return <PreventiveSchedulesPanel />;
    case "alerts/all":
      return <AlertsPanel />;
    case "alerts/history":
      return <AlertHistoryPanel />;
    case "alerts/rules":
      return <AlertRulesPanel />;
    case "admin/machines":
      return <MachineRegistryPanel />;
    case "admin/plant":
      return <PlantHierarchyPanel />;
    case "admin/shifts":
      return <ShiftPatternsPanel />;
    case "admin/statuses":
      return <MachineStatusDefinitionsPanel />;
    case "admin/fault-codes":
      return <MachineFaultCodesPanel />;
    case "admin/terminals":
      return <TerminalUisPanel />;
    case "admin/edge-nodes":
      return <EdgeNodesPanel />;
    case "admin/audit-log":
      return <AuditLogPanel />;
    default:
      return null;
  }
}

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
  const socketRef = useRef<WebSocket | null>(null);

  const { auth, logout, mfaSetupRequired } = useAuth();
  const token = auth?.token ?? null;

  // Élő eseményfolyam — csak bejelentkezve. Minden (újra)csatlakozás előtt
  // friss, egyszer használható ticketet kér (POST /api/auth/ws-ticket), mert
  // a böngésző WebSocketen nem tud Authorization headert küldeni. Ha a
  // session közben lejárt, a ticket kérése 401-et kap, az apiFetch
  // kilépteti a felhasználót, a token null lesz, és ez az effekt leáll.
  useEffect(() => {
    if (!token) {
      setConnected(false);
      setMachines({});
      return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    function scheduleRetry() {
      if (cancelled) return;
      failures++;
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 4));
      retryTimer = setTimeout(() => void connect(), delay);
    }

    async function connect() {
      if (cancelled) return;

      let ticket: string;
      try {
        const res = await apiFetch(`${API_BASE}/api/auth/ws-ticket`, { method: "POST" });
        if (!res.ok) throw new Error(`ws-ticket ${res.status}`);
        ticket = ((await res.json()) as { ticket: string }).ticket;
      } catch {
        scheduleRetry();
        return;
      }
      if (cancelled) return;

      const socket = new WebSocket(`${WS_URL}?ticket=${encodeURIComponent(ticket)}`);
      socketRef.current = socket;

      socket.onopen = () => {
        failures = 0;
        setConnected(true);
      };

      socket.onmessage = (raw) => {
        const message = JSON.parse(raw.data) as ServerMessage;
        if (message.type === "snapshot") {
          const byId = Object.fromEntries(message.machines.map((m) => [m.machineId, m]));
          setMachines(byId);
        } else {
          setMachines((prev) => applyEventToMachines(prev, message.event));
        }
      };

      socket.onclose = (event) => {
        if (socketRef.current === socket) socketRef.current = null;
        setConnected(false);
        if (cancelled) return;
        // A kapcsolat elérte a maximális élettartamát: azonnal újra, friss
        // tickettel, hogy a dashboardon ne villanjon fel a "disconnected".
        if (event.code === WS_CLOSE_REAUTH) {
          void connect();
          return;
        }
        scheduleRetry();
      };
    }

    void connect();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [token]);

  const role = auth?.role;
  const groups = useMemo(() => (role ? navForRole(role) : []), [role]);
  const path = usePath();
  const [, groupId = "", viewId = ""] = path.split("/");
  const activeGroup = groups.find((g) => g.id === groupId);
  const activeView = activeGroup?.items.find((i) => i.id === viewId);
  const alertCount = useOpenAlertCount(!!auth && !mfaSetupRequired);

  // "/" vagy ismeretlen / nem engedélyezett útvonal → az első elérhető nézet.
  useEffect(() => {
    if (auth && groups.length > 0 && !activeView) navigate(pathOf(groups[0]!, groups[0]!.items[0]!), { replace: true });
  }, [auth, groups, activeView]);

  if (mfaSetupRequired) {
    return <MfaSetup />;
  }

  if (!auth) {
    return <LoginForm />;
  }

  const navGroups = groups.map((g) => (g.id === "alerts" ? { ...g, badge: alertCount } : g));

  return (
    <ScopeProvider>
      <AppShell
        groups={navGroups}
        activeGroupId={activeGroup?.id ?? ""}
        activeItemId={activeView?.id ?? ""}
        connected={connected}
        role={auth.role}
        onSignOut={logout}
        topBarControls={<ScopeSelector />}
      >
        {activeGroup && activeView ? renderView(activeGroup.id, activeView.id, machines) : null}
      </AppShell>
    </ScopeProvider>
  );
}
