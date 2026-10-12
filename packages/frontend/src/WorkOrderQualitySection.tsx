import { useEffect, useState } from "react";
import { formatDateTime } from "./ui/format.js";
import QualityCheckDetail, { StatusPill } from "./QualityCheckDetail.js";
import { KIND_LABEL, listWorkOrderChecks, type CheckDetail } from "./quality.js";

/** The quality checks of one work order, each opening to every measurement (in the work order's side panel). */
export default function WorkOrderQualitySection({ workOrderId }: { workOrderId: string }) {
  const [checks, setChecks] = useState<CheckDetail[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    listWorkOrderChecks(workOrderId)
      .then((c) => alive && setChecks(c))
      .catch(() => alive && setChecks([]));
    return () => {
      alive = false;
    };
  }, [workOrderId, tick]);

  return (
    <section className="ui-section">
      <h3 className="ui-section-title">Quality checks</h3>
      {checks === null ? (
        <p className="ui-field-hint">Loading…</p>
      ) : checks.length === 0 ? (
        <p className="ui-field-hint" style={{ margin: 0 }}>
          None yet. If the part has a quality plan, the first-piece check opens when the order is started.
        </p>
      ) : (
        <ul className="q-wo-checks">
          {checks.map((c) => (
            <li key={c.id}>
              <button type="button" className="q-wo-check" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>
                <span>
                  <strong>{KIND_LABEL[c.kind]}</strong> <span className="ui-sub">{formatDateTime(c.createdAt)} · {c.passedCount}/{c.total} passed</span>
                </span>
                <StatusPill status={c.status} overdue={c.overdue} />
              </button>
              {open === c.id && (
                <div className="q-wo-check-body">
                  <QualityCheckDetail check={c} onChanged={() => setTick((n) => n + 1)} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
