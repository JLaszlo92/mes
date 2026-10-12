import { usePolling } from "./ui/usePolling.js";
import { useEffect, useState } from "react";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE } from "./api.js";
import { useScope } from "./scope.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import { formatDateTime } from "./ui/format.js";

interface DowntimePeriod {
  id: string;
  machineId: string;
  machineName: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
}

interface FaultCode {
  id: string;
  machineId: string;
  code: string;
  name: string;
  isActive: boolean;
}

interface DowntimeSummary {
  machineId: string;
  machineName: string;
  microStopThresholdSeconds: number;
  stops: number;
  stopSeconds: number;
  microStops: number;
  microStopSeconds: number;
  unexplained: number;
}

const SUMMARY_HOURS = 24;


function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `${fallback} (${res.status})`;
}

/** A küszöb szerkesztője egy sorban: helyi szövegállapot, mentés Enterre vagy fókuszvesztésre. */
function ThresholdInput({ summary, onSave }: { summary: DowntimeSummary; onSave: (seconds: number) => Promise<void> }) {
  const [value, setValue] = useState(String(summary.microStopThresholdSeconds));
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(String(summary.microStopThresholdSeconds)), [summary.microStopThresholdSeconds]);

  async function commit() {
    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds === summary.microStopThresholdSeconds) {
      setValue(String(summary.microStopThresholdSeconds));
      return;
    }
    setSaving(true);
    try {
      await onSave(seconds);
    } finally {
      setSaving(false);
    }
  }

  return (
    <input
      type="number"
      min={0}
      max={3600}
      step={1}
      value={value}
      disabled={saving}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="ui-input num"
      style={{ width: 72, height: 28, textAlign: "right" }}
      title="Micro-stop threshold in seconds — shorter stops are summarized, not listed for explanation"
    />
  );
}

export default function DowntimePeriodsPanel() {
  const { isInScope } = useScope();
  const { auth } = useAuth();
  const [periods, setPeriods] = useState<DowntimePeriod[]>([]);
  const [faultCodes, setFaultCodes] = useState<FaultCode[]>([]);
  const [summary, setSummary] = useState<DowntimeSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** A mentés alatt álló periódus — addig a gombjai zárolva vannak (dupla kattintás ellen). */
  const [explainingId, setExplainingId] = useState<string | null>(null);
  const [machineFilter, setMachineFilter] = useState("");

  const canEditThreshold = auth?.role === "admin" || auth?.role === "manager";

  // A token hozzáadását és a 401-es kiléptetést az apiFetch végzi.
  async function load() {
    try {
      const getJson = <T,>(path: string) =>
        apiFetch(`${API_BASE}${path}`).then((r) =>
          r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(`${path}: ${r.status}`)),
        );
      const [p, fc, s] = await Promise.all([
        getJson<DowntimePeriod[]>("/api/downtime-periods/unexplained"),
        getJson<FaultCode[]>("/api/fault-codes"),
        getJson<DowntimeSummary[]>(`/api/downtime-periods/summary?hours=${SUMMARY_HOURS}`),
      ]);
      setPeriods(p);
      setFaultCodes(fc);
      setSummary(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Live: new stops appear without a page reload.
  usePolling(() => void load(), 15_000, explainingId === null);

  async function explain(periodId: string, faultCodeId: string) {
    if (explainingId) return;
    setExplainingId(periodId);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/downtime-periods/${encodeURIComponent(periodId)}/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ faultCodeId }),
      });
      if (!res.ok) setError(await errorMessage(res, "Failed to record the reason"));
      await load();
    } finally {
      setExplainingId(null);
    }
  }

  async function saveThreshold(machineId: string, seconds: number) {
    setError(null);
    const res = await apiFetch(`${API_BASE}/api/machine-registry/${encodeURIComponent(machineId)}/micro-stop-threshold`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seconds }),
    });
    if (!res.ok) setError(await errorMessage(res, "Failed to save threshold"));
    await load();
  }

  const scopedSummary = summary.filter((s) => isInScope(s.machineId));
  const scopedPeriods = periods.filter((p) => isInScope(p.machineId) && (machineFilter === "" || p.machineId === machineFilter));
  const periodMachines = [...new Map(periods.filter((p) => isInScope(p.machineId)).map((p) => [p.machineId, p.machineName])).entries()].sort((a, b) =>
    a[1].localeCompare(b[1]),
  );

  const summaryColumns: Column<DowntimeSummary>[] = [
    { id: "machine", header: "Machine", sortValue: (s) => s.machineName, cell: (s) => s.machineName },
    { id: "stops", header: "Stops", align: "right", sortValue: (s) => s.stops, cell: (s) => s.stops },
    { id: "stopTime", header: "Stop time", align: "right", sortValue: (s) => s.stopSeconds, cell: (s) => formatDuration(s.stopSeconds) },
    { id: "micro", header: "Micro-stops", align: "right", sortValue: (s) => s.microStops, cell: (s) => s.microStops },
    { id: "microTime", header: "Micro-stop time", align: "right", sortValue: (s) => s.microStopSeconds, cell: (s) => formatDuration(s.microStopSeconds) },
    {
      id: "unexplained",
      header: "To explain",
      align: "right",
      sortValue: (s) => s.unexplained,
      cell: (s) => (s.unexplained > 0 ? <span className="ui-pill ui-pill-warning">{s.unexplained}</span> : 0),
    },
    {
      id: "threshold",
      header: "Threshold (s)",
      align: "right",
      sortValue: (s) => s.microStopThresholdSeconds,
      cell: (s) => (canEditThreshold ? <ThresholdInput summary={s} onSave={(seconds) => saveThreshold(s.machineId, seconds)} /> : s.microStopThresholdSeconds),
    },
  ];

  const periodColumns: Column<DowntimePeriod>[] = [
    { id: "machine", header: "Machine", sortValue: (p) => p.machineName, cell: (p) => p.machineName },
    { id: "started", header: "Started", sortValue: (p) => p.startedAt, cell: (p) => formatDateTime(p.startedAt) },
    { id: "ended", header: "Ended", sortValue: (p) => p.endedAt, cell: (p) => formatDateTime(p.endedAt) },
    { id: "duration", header: "Duration", align: "right", sortValue: (p) => p.durationSeconds, cell: (p) => formatDuration(p.durationSeconds) },
    {
      id: "reason",
      header: "Reason",
      cell: (p) => {
        const codes = faultCodes.filter((fc) => fc.machineId === p.machineId && fc.isActive);
        if (explainingId === p.id) return <span className="ui-sub">Saving…</span>;
        if (codes.length === 0) return <span className="ui-sub">No fault codes for this machine</span>;
        return (
          <select
            className="ui-select"
            value=""
            disabled={explainingId !== null}
            onChange={(e) => {
              if (e.target.value) void explain(p.id, e.target.value);
            }}
            aria-label={`Reason for the stop of ${p.machineName} at ${formatDateTime(p.startedAt)}`}
          >
            <option value="">Choose a reason…</option>
            {codes.map((fc) => (
              <option key={fc.id} value={fc.id}>
                {fc.code} — {fc.name}
              </option>
            ))}
          </select>
        );
      },
    },
  ];

  return (
    <>
      <section className="ui-panel" style={{ marginTop: 8 }}>
        <div className="ui-panel-head">
          <h2 className="ui-panel-title">Downtime — last {SUMMARY_HOURS} hours</h2>
          <span className="ui-panel-count num">{scopedSummary.length}</span>
        </div>
        <p className="ui-field-hint" style={{ marginTop: 0 }}>
          Stops shorter than a machine's micro-stop threshold are counted here but don't need a reason. Longer stops are listed below for explanation.
        </p>
        {error && <p className="ui-message ui-message-error">{error}</p>}
        <DataTable
          ariaLabel="Downtime summary"
          rows={scopedSummary}
          columns={summaryColumns}
          getRowId={(s) => s.machineId}
          initialSort={{ columnId: "unexplained", dir: "desc" }}
          emptyText="No machines in the current scope."
        />
      </section>

      <section className="ui-panel" style={{ marginTop: 24 }}>
        <div className="ui-panel-head">
          <h2 className="ui-panel-title">Unexplained downtime</h2>
          <span className="ui-panel-count num">{scopedPeriods.length}</span>
        </div>
        <div className="ui-toolbar">
          <select className="ui-select" value={machineFilter} onChange={(e) => setMachineFilter(e.target.value)} aria-label="Machine">
            <option value="">All machines</option>
            {periodMachines.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <DataTable
          ariaLabel="Unexplained downtime"
          paging={{ resetKey: [machineFilter] }}
          rows={scopedPeriods}
          columns={periodColumns}
          getRowId={(p) => p.id}
          initialSort={{ columnId: "started", dir: "desc" }}
          emptyText="No unexplained downtime."
        />
      </section>
    </>
  );
}
