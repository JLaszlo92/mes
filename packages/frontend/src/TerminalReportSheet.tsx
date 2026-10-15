import { useEffect, useMemo, useState } from "react";
import { TerminalSearch } from "./TerminalChoiceSheet.js";
import { matches } from "./ui/lists.js";

/** From this many scrap rows on, the report gets a search field. */
const REPORT_SEARCH_FROM = 8;
import { terminalApi, type OrderReport, type ReportDraft, type TerminalAssignment } from "./terminal-api.js";
import { hhmm, int } from "./terminal-model.js";

/**
 * Lejelentés a gépről: a megbízás végén (vagy szüneteltetéskor) a dolgozó
 * megadja a jó darabszámot és a selejtet okonként.
 *
 * - A jó darabszám a gép számlálásából indul (ebben a futásban), átírható.
 * - A selejt: ami már rögzítve van (a gép jele, terminálon lejelentett
 *   selejt), és okonként hozzáadható új selejt. "Levonás a jóból" módú
 *   gépen az új selejt a jó darabszámot is csökkenti.
 * - Ha a jó darab (az előző futásokkal együtt) eléri az előirányzottat, a
 *   megbízás lezárul; ha kevesebb, szüneteltetve marad, és később ezen a
 *   gépen folytatható. Szüneteltetni a cél elérése után is lehet.
 */
export default function TerminalReportSheet({
  terminalId,
  machineName,
  order,
  intent,
  busy,
  onCancel,
  onSubmit,
}: {
  terminalId: string;
  machineName: string;
  order: TerminalAssignment;
  /** "pause": opened with Szüneteltetés — only pausing is offered. */
  intent: "complete" | "pause";
  busy: boolean;
  onCancel: () => void;
  onSubmit: (report: OrderReport, outcome: "completed" | "paused") => void;
}) {
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Record<string, number>>({});
  const [goodEdited, setGoodEdited] = useState<number | null>(null);
  const [goodText, setGoodText] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    terminalApi
      .reportDraft(terminalId, order.workOrderId)
      .then((d) => alive && setDraft(d))
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [terminalId, order.workOrderId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const newScrap = Object.values(added).reduce((a, n) => a + n, 0);
  const reclassify = draft?.scrapMode === "reclassify";
  const suggestedGood = draft ? Math.max(0, draft.run.good - (reclassify ? newScrap : 0)) : 0;
  const good = goodEdited ?? suggestedGood;
  const total = draft ? draft.previous.good + good : 0;
  const missing = draft ? Math.max(0, draft.quantity - total) : 0;
  const tooMuchScrap = reclassify && draft !== null && newScrap > draft.run.good;

  /** Every reason of the machine, and the ones already recorded (also a reason no longer offered, or none). */
  const rows = useMemo(() => {
    if (!draft) return [];
    const recorded = new Map(draft.run.byReason.map((l) => [l.code ?? "", l]));
    const out: { key: string; reasonId: string | null; code: string | null; name: string; recorded: number }[] = draft.scrapReasons.map((r) => ({
      key: r.id,
      reasonId: r.id,
      code: r.code,
      name: r.name,
      recorded: recorded.get(r.code)?.quantity ?? 0,
    }));
    for (const l of draft.run.byReason) {
      if (l.code !== null && draft.scrapReasons.some((r) => r.code === l.code)) continue;
      out.push({ key: `rec:${l.code ?? ""}`, reasonId: null, code: l.code, name: l.code === null ? "Ok nélkül (a gép jelezte)" : l.name, recorded: l.quantity });
    }
    // What was recorded in this run first (biggest first), then the other reasons in their order; the order does not
    // change while the worker adds scrap, so a row never jumps away under the finger.
    return out.map((r, i) => ({ r, i })).sort((a, b) => b.r.recorded - a.r.recorded || a.i - b.i).map((x) => x.r);
  }, [draft]);
  const [query, setQuery] = useState("");
  const manyRows = rows.length >= REPORT_SEARCH_FROM;
  // A row with new scrap on it stays in view whatever the search.
  const shownRows = manyRows && query ? rows.filter((r) => (r.reasonId && (added[r.reasonId] ?? 0) > 0) || matches(`${r.name} ${r.code ?? ""}`, query)) : rows;

  function setGood(n: number) {
    const v = Math.max(0, Math.min(1_000_000, Math.round(n)));
    setGoodEdited(v);
    setGoodText(null);
  }
  function addScrap(reasonId: string, n: number) {
    setAdded((a) => ({ ...a, [reasonId]: Math.max(0, Math.min(1000, (a[reasonId] ?? 0) + n)) }));
  }
  function submit(pause: boolean) {
    if (!draft) return;
    const scrap = Object.entries(added)
      .filter(([, q]) => q > 0)
      .map(([reasonId, quantity]) => ({ reasonId, quantity }));
    onSubmit({ good, scrap, pause }, !pause && missing === 0 ? "completed" : "paused");
  }

  return (
    <div className="term-pin" role="dialog" aria-modal="true" aria-label={`Lejelentés a gépről — ${order.orderNumber}`} onClick={onCancel}>
      <div className="term-sheet tx-report" onClick={(e) => e.stopPropagation()}>
        <div className="term-sheet-head">
          <div>
            <div className="term-pin-title">
              {intent === "pause" ? "Szüneteltetés — lejelentés a gépről" : "Lejelentés a gépről"} — {machineName}
            </div>
            <div className="term-pin-sub">
              {order.partName} · {order.orderNumber}
              {draft && ` · futás ${hhmm(draft.run.startedAt)} óta${draft.run.startedBy ? ` (${draft.run.startedBy})` : ""}`}
            </div>
          </div>
          <button type="button" className="term-btn term-btn-ghost" onClick={onCancel}>
            Mégse
          </button>
        </div>

        {error && <p className="term-error">{error}</p>}
        {!draft && !error && <p className="term-sub">Betöltés…</p>}

        {draft && (
          <>
            <div className="tx-report-grid">
              <section className="tx-report-good" aria-label="Jó darab">
                <div className="tx-scrap-label">Jó darab ebben a futásban</div>
                <div className="tx-scrap-qty">
                  <button type="button" className="tx-scrap-step" aria-label="Eggyel kevesebb jó darab" onClick={() => setGood(good - 1)} disabled={good <= 0}>
                    −
                  </button>
                  <input
                    className="tx-report-input"
                    aria-label="Jó darabszám"
                    inputMode="numeric"
                    value={goodText ?? String(good)}
                    onChange={(e) => {
                      const t = e.target.value.replace(/[^0-9]/g, "");
                      setGoodText(t);
                      if (t !== "") setGoodEdited(Math.min(1_000_000, Number(t)));
                    }}
                    onBlur={() => setGoodText(null)}
                    onFocus={(e) => e.target.select()}
                  />
                  <button type="button" className="tx-scrap-step" aria-label="Eggyel több jó darab" onClick={() => setGood(good + 1)}>
                    +
                  </button>
                </div>
                <div className="tx-report-hint">
                  A gép számolt: <strong>{int(draft.run.good)} db</strong>
                  {reclassify && newScrap > 0 && ` − ${int(newScrap)} új selejt`}
                  {goodEdited !== null && goodEdited !== suggestedGood && (
                    <button type="button" className="tx-link-btn" onClick={() => setGoodEdited(null)}>
                      vissza: {int(suggestedGood)}
                    </button>
                  )}
                </div>
                <div className="tx-report-total">
                  <div className="tx-report-total-line">
                    <span className="tx-muted">Összesen a megbízáson</span>
                    <strong>
                      {int(total)} <span className="tx-muted">/ {int(draft.quantity)} db</span>
                    </strong>
                  </div>
                  <div className="tx-progress tx-progress-thin" data-paused={missing > 0 ? "true" : undefined}>
                    <div style={{ width: `${Math.min(100, (total / Math.max(1, draft.quantity)) * 100)}%` }} />
                  </div>
                  {draft.previous.runs > 0 && (
                    <span className="tx-muted tx-small">
                      ebből korábbi lejelentések ({draft.previous.runs}): {int(draft.previous.good)} jó · {int(draft.previous.scrap)} selejt
                    </span>
                  )}
                </div>
              </section>

              <section className="tx-report-scrap" aria-label="Selejt okonként">
                <div className="tx-scrap-label">Selejt okonként</div>
                {rows.length === 0 ? (
                  <p className="term-sub">Ehhez a géphez nincs selejtok felvéve (Admin → Scrap reasons).</p>
                ) : (
                  <>
                  {manyRows && <TerminalSearch value={query} onChange={setQuery} total={rows.length} found={shownRows.length} />}
                  <div className="tx-report-rows">
                    {shownRows.map((r) => {
                      const add = r.reasonId ? (added[r.reasonId] ?? 0) : 0;
                      return (
                        <div key={r.key} className="tx-report-row" data-active={add > 0 ? "true" : undefined}>
                          <div className="tx-report-reason">
                            <strong>{r.name}</strong>
                            <span className="tx-muted tx-small">
                              {r.code ?? "—"}
                              {r.recorded > 0 && ` · rögzítve: ${int(r.recorded)} db`}
                            </span>
                          </div>
                          {r.reasonId ? (
                            <div className="tx-report-stepper">
                              <button type="button" aria-label={`${r.name}: eggyel kevesebb`} onClick={() => addScrap(r.reasonId!, -1)} disabled={add <= 0}>
                                −
                              </button>
                              <output aria-label={`${r.name}: új selejt`}>{add > 0 ? `+${int(add)}` : "0"}</output>
                              <button type="button" aria-label={`${r.name}: eggyel több`} onClick={() => addScrap(r.reasonId!, 1)}>
                                +
                              </button>
                            </div>
                          ) : (
                            <span className="tx-muted tx-small tx-report-fixed">{int(r.recorded)} db</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  </>
                )}
                <div className="tx-report-hint">
                  Selejt összesen: <strong>{int(draft.run.scrap + newScrap)} db</strong>
                  {newScrap > 0 && ` (ebből új: ${int(newScrap)})`}
                  <br />
                  <span className="tx-small">{reclassify ? "Az új selejt a gép jó darabjai közül vonódik le." : "Az új selejt a gép számlálója mellé jön."}</span>
                </div>
              </section>
            </div>

            {tooMuchScrap && <p className="term-error">Legfeljebb {int(draft.run.good)} db selejt vonható le (ennyi jó darabot számolt a gép ebben a futásban).</p>}

            <div className="tx-report-foot">
              <div className="tx-report-outcome" data-kind={missing > 0 ? "pause" : "done"}>
                {intent === "pause"
                  ? `A megbízás szüneteltetve lesz${missing > 0 ? ` (még ${int(missing)} db hiányzik)` : ""}, és később ezen a gépen folytatható.`
                  : missing > 0
                    ? `Még ${int(missing)} db hiányzik: a megbízás szüneteltetve marad, és később ezen a gépen folytatható.`
                    : draft.quantity > 0
                      ? "Az előirányzott jó darabszám megvan: a megbízás lezárható."
                      : ""}
              </div>
              <button type="button" className="term-btn tx-report-pause" data-main={intent === "pause" || missing > 0 ? "true" : undefined} disabled={busy || tooMuchScrap} onClick={() => submit(true)}>
                Szüneteltetés
              </button>
              {intent === "complete" && missing === 0 && (
                <button type="button" className="term-btn term-btn-done tx-report-main" disabled={busy || tooMuchScrap} onClick={() => submit(false)}>
                  Lezárás
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
