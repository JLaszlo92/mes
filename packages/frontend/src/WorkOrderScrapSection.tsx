import { useEffect, useState } from "react";
import { formatDateTime } from "./ui/format.js";
import { Pareto } from "./ScrapPanel.js";
import { scrapApi, type ScrapAnalysis, type ScrapBooking } from "./scrap.js";
import { CappedList } from "./ui/lists.js";

/** Scrap of one work order (its machine, from its start to its end) by reason, and the reports made at the terminal. */
export default function WorkOrderScrapSection({ workOrderId }: { workOrderId: string }) {
  const [analysis, setAnalysis] = useState<ScrapAnalysis | null>(null);
  const [bookings, setBookings] = useState<ScrapBooking[]>([]);
  useEffect(() => {
    let alive = true;
    void scrapApi.analysis({ workOrderId }).then((a) => alive && setAnalysis(a), () => alive && setAnalysis({ totalScrap: 0, totalGood: 0, byReason: [], byMachine: [] }));
    void scrapApi.bookings({ workOrderId, limit: "50" }).then((b) => alive && setBookings(b.rows), () => {});
    return () => {
      alive = false;
    };
  }, [workOrderId]);
  return (
    <section className="ui-section">
      <h3 className="ui-section-title">Scrap</h3>
      {analysis === null ? (
        <p className="ui-field-hint">Loading…</p>
      ) : analysis.totalScrap === 0 ? (
        <p className="ui-field-hint" style={{ margin: 0 }}>
          No scrap on this order.
        </p>
      ) : (
        <>
          <Pareto rows={analysis.byReason} total={analysis.totalScrap} />
          {bookings.length > 0 && (
            <CappedList items={bookings} limit={10} className="sc-bookings" empty="" footer={bookings.length >= 50 ? <span className="ui-field-hint">The latest 50 reports — all of them under Quality → Scrap.</span> : undefined} render={(b) => (
                <li key={b.id}>
                  <strong className="num">{b.quantity}</strong> {b.reasonName} <span className="ui-sub">{formatDateTime(b.bookedAt)} · {b.bookedByName ?? "—"} · {b.terminalName ?? ""}</span>
                </li>
            )} />
          )}
        </>
      )}
    </section>
  );
}
