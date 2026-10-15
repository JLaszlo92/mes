import { useEffect, useState } from "react";
import { apiFetch, API_BASE } from "./api.js";
import { readJsonOrThrow } from "./master-data.js";
import { formatDateTime } from "./ui/format.js";
import { Capped } from "./ui/lists.js";

interface Run {
  id: string;
  machineName: string | null;
  startedAt: string;
  startedByName: string | null;
  endedAt: string | null;
  endReason: "paused" | "completed" | "cancelled" | null;
  countedGood: number | null;
  countedScrap: number | null;
  reportedGood: number | null;
  reportedScrap: number | null;
  scrapBreakdown: { code: string | null; name: string; quantity: number }[];
  reportedManually: boolean;
  endedByName: string | null;
  terminalName: string | null;
}

const END_LABEL: Record<string, string> = { paused: "Paused", completed: "Completed", cancelled: "Cancelled" };

/**
 * The order's runs on the machine: each start / resume until it was reported off (paused or completed). What the
 * machine counted and what the worker reported, the scrap by reason, who and where.
 */
export default function WorkOrderRunsSection({ workOrderId, quantity, status }: { workOrderId: string; quantity: number; status: string }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  useEffect(() => {
    let alive = true;
    void apiFetch(`${API_BASE}/api/work-orders/${encodeURIComponent(workOrderId)}/runs`)
      .then((r) => readJsonOrThrow<Run[]>(r))
      .then((r) => alive && setRuns(r), () => alive && setRuns([]));
    return () => {
      alive = false;
    };
  }, [workOrderId, status]);

  if (runs === null || runs.length === 0) return null;
  const reported = runs.filter((r) => r.endedAt !== null).reduce((a, r) => a + (r.reportedGood ?? 0), 0);

  return (
    <section className="ui-section">
      <h3 className="ui-section-title">Production runs</h3>
      {status === "paused" && (
        <p className="ui-field-hint" style={{ marginTop: 0 }}>
          <span className="ui-pill ui-pill-warning">Paused</span> {reported} of {quantity} good parts reported — it can be resumed at the terminal of its machine.
        </p>
      )}
      <Capped items={runs} limit={5} fromEnd>
      {(shown) => (
      <ol className="wo-runs">
        {shown.map((r) => {
          const i = runs.indexOf(r);
          const corrected = r.reportedManually && r.countedGood !== null && r.reportedGood !== r.countedGood;
          return (
            <li key={r.id} className="wo-run">
              <div className="wo-run-head">
                <strong>Run {i + 1}</strong>
                <span className="ui-sub">{r.machineName ?? "—"}</span>
                <span className="ui-toolbar-spacer" />
                {r.endedAt === null ? (
                  <span className="ui-pill ui-pill-accent">Running</span>
                ) : (
                  <span className={`ui-pill ${r.endReason === "paused" ? "ui-pill-warning" : ""}`}>{END_LABEL[r.endReason ?? ""] ?? r.endReason}</span>
                )}
              </div>
              <div className="ui-sub">
                {formatDateTime(r.startedAt)}
                {r.startedByName ? ` · ${r.startedByName}` : ""} → {r.endedAt ? `${formatDateTime(r.endedAt)}${r.endedByName ? ` · ${r.endedByName}` : ""}${r.terminalName ? ` · ${r.terminalName}` : ""}` : "now"}
              </div>
              {r.endedAt !== null && (
                <dl className="ui-facts wo-run-facts">
                  <dt>Good</dt>
                  <dd>
                    <strong className="num">{r.reportedGood ?? 0}</strong>
                    {corrected && <span className="ui-sub"> (machine counted {r.countedGood}, corrected at the report)</span>}
                    {!r.reportedManually && <span className="ui-sub"> (machine count, no report)</span>}
                  </dd>
                  <dt>Scrap</dt>
                  <dd>
                    <strong className="num">{r.reportedScrap ?? 0}</strong>
                    {r.scrapBreakdown.length > 0 && (
                      <span className="ui-sub"> — {r.scrapBreakdown.map((l) => `${l.name} ${l.quantity}`).join(", ")}</span>
                    )}
                  </dd>
                </dl>
              )}
            </li>
          );
        })}
      </ol>
      )}
      </Capped>
    </section>
  );
}
