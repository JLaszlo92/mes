import { useState } from "react";
import { useAuth } from "./auth-context.js";
import { formatDateTime } from "./ui/format.js";
import { fmt, formatLimits, formatResult, KIND_LABEL, releaseCheck, STATUS_LABEL, statusTone, TRIGGER_LABEL, type CheckDetail, type CheckStatus } from "./quality.js";

export function StatusPill({ status, overdue }: { status: CheckStatus; overdue?: boolean }) {
  const tone = statusTone(status);
  const cls = tone === "alarm" ? "ui-pill ui-pill-alarm" : tone === "warn" ? "ui-pill ui-pill-warning" : tone === "neutral" ? "ui-pill ui-pill-accent" : "ui-pill";
  return (
    <span className={cls}>
      {STATUS_LABEL[status]}
      {overdue ? " · overdue" : ""}
    </span>
  );
}

/** Where the value sits between the limits: a small bar, the limits at 20% and 80%. */
export function ToleranceBar({ value, lower, upper }: { value: number | null; lower: number | null; upper: number | null }) {
  if (value === null || (lower === null && upper === null)) return null;
  const lo = lower ?? upper! - Math.abs(upper!) * 0.2 - 1;
  const hi = upper ?? lower! + Math.abs(lower!) * 0.2 + 1;
  const span = hi - lo || 1;
  const pos = Math.min(100, Math.max(0, 20 + ((value - lo) / span) * 60));
  const inside = (lower === null || value >= lower) && (upper === null || value <= upper);
  return (
    <span className="q-bar" aria-hidden="true">
      <span className="q-bar-zone" />
      <span className="q-bar-mark" data-inside={inside} style={{ left: `${pos}%` }} />
    </span>
  );
}

/**
 * Egy ellenőrzés teljes nyoma: a jellemzők sorrendben, minden próbálkozás
 * (érték, a mérés pillanatában érvényes határok, ki, mikor, melyik
 * terminálon), és a feloldás indoklása. Nyitott ellenőrzésnél a quality
 * supervisor itt is feloldhatja.
 */
export default function QualityCheckDetail({ check, onChanged }: { check: CheckDetail; onChanged?: () => void }) {
  const { can } = useAuth();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = check.status === "open" || check.status === "failed";

  async function release() {
    setBusy(true);
    setError(null);
    try {
      await releaseCheck(check.id, reason.trim());
      setReason("");
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="ui-section">
        <dl className="ui-facts">
          <dt>Check</dt>
          <dd>
            {KIND_LABEL[check.kind]} <span className="ui-sub">raised by {TRIGGER_LABEL[check.trigger] ?? check.trigger} · plan v{check.planVersion}</span>
          </dd>
          <dt>Status</dt>
          <dd>
            <StatusPill status={check.status} overdue={check.overdue} />
            {check.gating && active && <span className="ui-sub">{check.kind === "first_piece" ? "Parts are not counted until it passes." : "The order cannot be completed until it passes."}</span>}
            {check.status === "failed" && <span className="ui-sub">Parts are not counted until it is measured again and passes, or released.</span>}
          </dd>
          <dt>Work order</dt>
          <dd>
            {check.orderNumber} <span className="ui-sub">{check.partName}</span>
          </dd>
          <dt>Machine</dt>
          <dd>{check.machineName ?? check.machineId ?? "—"}</dd>
          <dt>Raised</dt>
          <dd>{formatDateTime(check.createdAt)}</dd>
          {check.closedAt && (
            <>
              <dt>Closed</dt>
              <dd>
                {formatDateTime(check.closedAt)} {check.closedByName && <span className="ui-sub">{check.closedByName}</span>}
              </dd>
            </>
          )}
          {check.releaseReason && (
            <>
              <dt>Reason of release</dt>
              <dd>{check.releaseReason}</dd>
            </>
          )}
        </dl>
      </section>

      <section className="ui-section">
        <h3 className="ui-section-title">
          Measurements ({check.passedCount} of {check.total} passed{check.failedAttempts ? `, ${check.failedAttempts} failed attempt${check.failedAttempts === 1 ? "" : "s"}` : ""})
        </h3>
        <div className="ui-table-wrap" style={{ maxHeight: "none" }}>
          <table className="ui-table q-measure-table">
            <thead>
              <tr>
                <th>Measurement</th>
                <th>Result</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {check.items.map((item, i) => {
                const rows = item.attempts.length ? item.attempts : [null];
                return rows.map((m, j) => (
                  <tr key={`${item.id}-${j}`}>
                    {j === 0 && (
                      <>
                        <td rowSpan={rows.length}>
                          {i + 1}. {item.name}
                          <span className="ui-sub">
                            {formatLimits(m ?? item)}
                            {item.kind === "variable" && (m ?? item).nominal !== null ? ` · nominal ${fmt((m ?? item).nominal)}` : ""}
                            {item.method ? ` · ${item.method}` : ""}
                          </span>
                        </td>
                      </>
                    )}
                    <td className={m && !m.passed ? "q-fail" : undefined}>
                      {m ? (
                        <span className="q-result">
                          <strong>{formatResult(m)}</strong> {m.passed ? <span className="ui-pill">OK</span> : <span className="ui-pill ui-pill-alarm">Out</span>}
                          {m.kind === "variable" && <ToleranceBar value={m.value} lower={m.lowerLimit} upper={m.upperLimit} />}
                          <span className="ui-sub">
                            attempt {m.attempt}
                            {m.comment ? ` · ${m.comment}` : ""}
                          </span>
                        </span>
                      ) : check.nextCharacteristicId === item.id ? (
                        <span className="ui-pill ui-pill-accent">Next</span>
                      ) : (
                        <span className="ui-sub">Not measured</span>
                      )}
                    </td>
                    <td className={m && !m.passed ? "q-fail" : undefined}>
                      {m ? (
                        <span>
                          {m.measuredByName ?? "—"}
                          <span className="ui-sub">
                            {formatDateTime(m.measuredAt)}
                            {m.terminalName ? ` · ${m.terminalName}` : ""}
                          </span>
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
      </section>

      {active && can("quality.release") && (
        <section className="ui-section">
          <h3 className="ui-section-title">Release</h3>
          <p className="ui-field-hint" style={{ marginTop: 0 }}>
            Lets production go on without a passing measurement (deviation). The reason is kept with the check.
          </p>
          <textarea className="ui-textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason, e.g. customer deviation no. 123, gauge under calibration…" aria-label="Reason of release" />
          {error && <p className="ui-message ui-message-error">{error}</p>}
          <button type="button" className="ui-btn ui-btn-primary" style={{ marginTop: 8 }} disabled={busy || reason.trim().length < 3} onClick={release}>
            {busy ? "Releasing…" : "Release check"}
          </button>
        </section>
      )}
    </>
  );
}
