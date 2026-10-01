import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";
import { apiFetch, API_BASE } from "./api.js";
import { useScope } from "./scope.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import Drawer from "./ui/Drawer.js";
import Field from "./ui/Field.js";
import Pager from "./ui/Pager.js";
import { formatDateTime } from "./ui/format.js";
import { useServerList } from "./ui/useServerList.js";
import { readJsonOrThrow } from "./master-data.js";

type ReportStatus = "pending" | "confirmed" | "modified" | "rejected";

interface FaultReport {
  id: string;
  machineId: string;
  machineName: string;
  faultCode: string;
  faultName: string;
  occurrenceCount: number;
  comment: string | null;
  status: ReportStatus;
  reportedByEmail: string | null;
  reportedAt: string;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  reviewerNote: string | null;
}

interface FaultCode {
  id: string;
  machineId: string;
  code: string;
  name: string;
  isActive?: boolean;
}

interface CorrectiveAction {
  id: string;
  description: string;
  performedByEmail: string | null;
  performedAt: string;
  signedOffByEmail: string | null;
  signedOffAt: string | null;
}

const STATUS_LABEL: Record<ReportStatus, string> = { pending: "Pending review", confirmed: "Confirmed", modified: "Confirmed (adjusted)", rejected: "Rejected" };

/**
 * Hibajelentések szerveroldali lapozással: alapból a felülvizsgálatra
 * várók. A részletek (felülvizsgálat, korrekciós intézkedések, munkarendelés)
 * az oldalpanelben.
 */
export default function FaultReportsPanel() {
  const { auth } = useAuth();
  const { isFiltered, machines, isInScope } = useScope();
  const [status, setStatus] = useState<ReportStatus | "reviewed" | "">("pending");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<FaultReport | null>(null);
  const [reporting, setReporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const machineIds = useMemo(() => (isFiltered ? machines.filter((m) => isInScope(m.id)).map((m) => m.id).join(",") || "-" : undefined), [isFiltered, machines, isInScope]);
  const list = useServerList<FaultReport>("/api/fault-reports/page", { status: status || undefined, q: query.trim() || undefined, machineIds }, { refreshMs: 30_000 });

  const columns: Column<FaultReport>[] = [
    { id: "reported", header: "Reported", cell: (r) => formatDateTime(r.reportedAt) },
    { id: "machine", header: "Machine", cell: (r) => r.machineName },
    {
      id: "fault",
      header: "Fault",
      cell: (r) => (
        <span>
          {r.faultCode}
          <span className="ui-sub">{r.faultName}</span>
        </span>
      ),
    },
    { id: "count", header: "Count", align: "right", cell: (r) => r.occurrenceCount },
    { id: "status", header: "Status", cell: (r) => (r.status === "pending" ? <span className="ui-pill ui-pill-warning">{STATUS_LABEL[r.status]}</span> : STATUS_LABEL[r.status]) },
    { id: "by", header: "Reported by", cell: (r) => r.reportedByEmail ?? "—" },
    { id: "comment", header: "Comment", cell: (r) => (r.comment ? <span title={r.comment}>{r.comment}</span> : "—") },
  ];

  return (
    <section className="ui-panel" style={{ marginTop: 8 }}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Fault reports</h2>
        <span className="ui-panel-count num">{list.total.toLocaleString()}</span>
        <span className="ui-toolbar-spacer" />
        <button type="button" className="ui-btn ui-btn-primary" onClick={() => setReporting(true)} disabled={!auth}>
          Report a fault
        </button>
      </div>
      <div className="ui-toolbar" role="search">
        <input className="ui-input ui-search" type="search" placeholder="Search machine, code, comment…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search fault reports" />
        <select className="ui-select" value={status} onChange={(e) => setStatus(e.target.value as ReportStatus | "reviewed" | "")} aria-label="Status">
          <option value="pending">Pending review</option>
          <option value="reviewed">Reviewed</option>
          <option value="confirmed">Confirmed</option>
          <option value="modified">Confirmed (adjusted)</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </select>
      </div>
      {list.error && <p className="ui-message ui-message-error">{list.error}</p>}
      {notice && <p className="ui-message ui-message-info">{notice}</p>}
      <DataTable
        ariaLabel="Fault reports"
        rows={list.rows}
        columns={columns}
        getRowId={(r) => r.id}
        onRowClick={setOpen}
        isDimmed={(r) => r.status === "rejected"}
        emptyText={list.loading ? "Loading…" : status === "pending" ? "Nothing waiting for review." : "No fault reports match these filters."}
      />
      <Pager offset={list.offset} limit={list.limit} total={list.total} onChange={list.setPage} />

      {open && (
        <FaultReportDrawer
          report={open}
          role={auth?.role ?? ""}
          onClose={() => setOpen(null)}
          onChanged={(r, message) => {
            setOpen(r);
            setNotice(message);
            list.reload();
          }}
        />
      )}
      {reporting && (
        <ReportFaultDrawer
          machines={machines.filter((m) => m.isActive && isInScope(m.id))}
          onClose={() => setReporting(false)}
          onCreated={() => {
            setReporting(false);
            setNotice("Fault reported.");
            list.reload();
          }}
        />
      )}
    </section>
  );
}

function FaultReportDrawer({ report, role, onClose, onChanged }: { report: FaultReport; role: string; onClose: () => void; onChanged: (r: FaultReport, message: string) => void }) {
  const canReview = role === "manager" || role === "admin";
  const canSignOff = ["supervisor", "manager", "admin"].includes(role);
  const canCreateTicket = ["supervisor", "maintenance", "manager", "admin"].includes(role);
  const [actions, setActions] = useState<CorrectiveAction[]>([]);
  const [count, setCount] = useState(String(report.occurrenceCount));
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function loadActions() {
    apiFetch(`${API_BASE}/api/corrective-actions?faultReportId=${encodeURIComponent(report.id)}`)
      .then((r) => readJsonOrThrow<CorrectiveAction[]>(r))
      .then(setActions)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }
  useEffect(loadActions, [report.id]);

  async function call<T>(url: string, method: string, body: Record<string, unknown> | undefined, after: (result: T) => void) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}${url}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      after(await readJsonOrThrow<T>(res));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function review(status: "confirmed" | "modified" | "rejected") {
    const adjusted = Number(count);
    if (status === "modified" && (!Number.isInteger(adjusted) || adjusted < 1)) return setError("Enter the corrected count.");
    void call<FaultReport>(
      `/api/fault-reports/${encodeURIComponent(report.id)}/review`,
      "PUT",
      { status, adjustedCount: status === "modified" ? adjusted : undefined, reviewerNote: note.trim() || undefined },
      (r) => onChanged({ ...report, ...r }, `Report ${status === "rejected" ? "rejected" : "confirmed"}.`),
    );
  }

  const reviewed = report.status !== "pending";

  return (
    <Drawer title={`${report.faultCode} on ${report.machineName}`} subtitle={report.faultName} onRequestClose={onClose}>
      {error && <p className="ui-message ui-message-error">{error}</p>}
      <section className="ui-section">
        <dl className="ui-facts">
          <dt>Status</dt>
          <dd>{STATUS_LABEL[report.status]}</dd>
          <dt>Count</dt>
          <dd className="num">{report.occurrenceCount}</dd>
          <dt>Reported</dt>
          <dd>
            {formatDateTime(report.reportedAt)} by {report.reportedByEmail ?? "—"}
          </dd>
          {report.comment && (
            <>
              <dt>Comment</dt>
              <dd>{report.comment}</dd>
            </>
          )}
          {reviewed && (
            <>
              <dt>Reviewed</dt>
              <dd>
                {formatDateTime(report.reviewedAt)} by {report.reviewedByEmail ?? "—"}
              </dd>
              {report.reviewerNote && (
                <>
                  <dt>Note</dt>
                  <dd>{report.reviewerNote}</dd>
                </>
              )}
            </>
          )}
        </dl>
        {canCreateTicket && (report.status === "confirmed" || report.status === "modified") && (
          <button
            type="button"
            className="ui-btn"
            disabled={busy}
            onClick={() =>
              void call(
                "/api/maintenance-work-orders",
                "POST",
                { machineId: report.machineId, title: `${report.faultCode} — ${report.faultName}`, description: report.comment ?? undefined, sourceType: "fault_report", sourceId: report.id },
                () => onChanged(report, "Maintenance work order created."),
              )
            }
          >
            Create maintenance work order
          </button>
        )}
      </section>

      {canReview && !reviewed && (
        <section className="ui-section">
          <h3 className="ui-section-title">Review</h3>
          <div className="ui-grid-2">
            <Field label="Count" hint="Change it to confirm with a corrected count.">
              <input className="ui-input num" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
            </Field>
          </div>
          <div style={{ marginTop: 12 }}>
            <Field label="Note (optional)">
              <input className="ui-input" value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button type="button" className="ui-btn ui-btn-primary" disabled={busy} onClick={() => review(Number(count) === report.occurrenceCount ? "confirmed" : "modified")}>
              {Number(count) === report.occurrenceCount ? "Confirm" : `Confirm with count ${count}`}
            </button>
            <button type="button" className="ui-btn ui-btn-danger" disabled={busy} onClick={() => review("rejected")}>
              Reject
            </button>
          </div>
        </section>
      )}

      {report.status !== "rejected" && (
        <section className="ui-section">
          <h3 className="ui-section-title">Corrective actions</h3>
          {actions.length === 0 ? (
            <p className="ui-field-hint" style={{ marginTop: 0 }}>
              None logged yet.
            </p>
          ) : (
            <ul className="ui-mini-list">
              {actions.map((a) => (
                <li key={a.id}>
                  <span style={{ flex: 1 }}>
                    {a.description}
                    <span className="ui-sub">
                      {a.performedByEmail ?? "—"}, {formatDateTime(a.performedAt)}
                    </span>
                  </span>
                  {a.signedOffAt ? (
                    <span className="ui-sub">Signed off by {a.signedOffByEmail}</span>
                  ) : canSignOff ? (
                    <button
                      type="button"
                      className="ui-btn ui-btn-small"
                      disabled={busy}
                      onClick={() => void call(`/api/corrective-actions/${encodeURIComponent(a.id)}/sign-off`, "PUT", undefined, () => loadActions())}
                    >
                      Sign off
                    </button>
                  ) : (
                    <span className="ui-pill ui-pill-warning">Awaiting sign-off</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <form
            className="ui-inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draft.trim()) return;
              void call("/api/corrective-actions", "POST", { faultReportId: report.id, description: draft.trim() }, () => {
                setDraft("");
                loadActions();
              });
            }}
          >
            <input className="ui-input" style={{ flex: 1, minWidth: 200 }} placeholder="What was done about it" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Corrective action" />
            <button type="submit" className="ui-btn" disabled={busy || !draft.trim()}>
              Log action
            </button>
          </form>
        </section>
      )}
    </Drawer>
  );
}

function ReportFaultDrawer({ machines, onClose, onCreated }: { machines: { id: string; name: string }[]; onClose: () => void; onCreated: () => void }) {
  const [codes, setCodes] = useState<FaultCode[]>([]);
  const [form, setForm] = useState({ machineId: machines[0]?.id ?? "", faultCodeId: "", occurrenceCount: "1", comment: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch(`${API_BASE}/api/fault-codes`)
      .then((r) => readJsonOrThrow<FaultCode[]>(r))
      .then(setCodes)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const available = codes.filter((c) => c.machineId === form.machineId && c.isActive !== false);
  const valid = form.machineId && form.faultCodeId && Number(form.occurrenceCount) >= 1;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/api/fault-reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machineId: form.machineId,
          faultCodeId: form.faultCodeId,
          occurrenceCount: Number(form.occurrenceCount),
          comment: form.comment.trim() || undefined,
        }),
      });
      await readJsonOrThrow<unknown>(res);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      title="Report a fault"
      onRequestClose={onClose}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="ui-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="report-fault-form" className="ui-btn ui-btn-primary" disabled={saving || !valid}>
            {saving ? "Reporting…" : "Report"}
          </button>
        </>
      }
    >
      <form id="report-fault-form" onSubmit={submit}>
        <section className="ui-section">
          {error && <p className="ui-message ui-message-error">{error}</p>}
          <div className="ui-grid-2">
            <Field label="Machine">
              <select className="ui-select" value={form.machineId} onChange={(e) => setForm({ ...form, machineId: e.target.value, faultCodeId: "" })}>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Fault code" hint={form.machineId && available.length === 0 ? "This machine has no fault codes yet (Admin → Fault codes)." : undefined}>
              <select className="ui-select" value={form.faultCodeId} onChange={(e) => setForm({ ...form, faultCodeId: e.target.value })} disabled={available.length === 0}>
                <option value="">Choose…</option>
                {available.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} — {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Count">
              <input className="ui-input num" inputMode="numeric" value={form.occurrenceCount} onChange={(e) => setForm({ ...form, occurrenceCount: e.target.value })} />
            </Field>
          </div>
          <div style={{ marginTop: 12 }}>
            <Field label="Comment (optional)">
              <textarea className="ui-textarea" value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} />
            </Field>
          </div>
        </section>
      </form>
    </Drawer>
  );
}
