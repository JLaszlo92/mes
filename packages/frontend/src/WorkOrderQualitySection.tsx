import { useEffect, useState } from "react";
import { formatDateTime } from "./ui/format.js";
import QualityCheckDetail, { StatusPill } from "./QualityCheckDetail.js";
import { KIND_LABEL, listWorkOrderChecks, type CheckDetail } from "./quality.js";
import { CappedList } from "./ui/lists.js";

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
        <CappedList items={ordered(checks)} limit={10} className="q-wo-checks" empty="" render={(c) => (
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
        )} />
      )}
    </section>
  );
}

/** First and last piece first, then the spot checks newest first (an order may have hundreds of them). */
function ordered<T extends { kind: string; createdAt: string }>(checks: readonly T[]): T[] {
  const rank = (c: T) => (c.kind === "first_piece" ? 0 : c.kind === "last_piece" ? 1 : 2);
  return [...checks].sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? b.createdAt.localeCompare(a.createdAt) : a.createdAt.localeCompare(b.createdAt)));
}
