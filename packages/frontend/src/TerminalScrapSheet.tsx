import { useEffect, useState } from "react";
import { SEARCH_FROM, TerminalSearch } from "./TerminalChoiceSheet.js";
import { matches } from "./ui/lists.js";
import type { TerminalMachine } from "./terminal-api.js";
import { int, runningOrder } from "./terminal-model.js";

/**
 * Selejt lejelentése a terminálon: ok (a gép selejtokai) és mennyiség, egy
 * képernyőn. A "Lejelentés" után a terminál kéri a dolgozó kódját.
 */
export default function TerminalScrapSheet({
  m,
  busy,
  onCancel,
  onSubmit,
}: {
  m: TerminalMachine;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (reason: { id: string; code: string; name: string }, quantity: number) => void;
}) {
  const [reasonId, setReasonId] = useState<string | null>(m.scrapReasons.length === 1 ? m.scrapReasons[0]!.id : null);
  const [qty, setQty] = useState(1);
  const run = runningOrder(m);
  const good = run ? (m.orders[run.workOrderId]?.progress?.goodCount ?? 0) : 0;
  const max = m.scrapMode === "reclassify" ? Math.max(0, good) : 1000;
  const reason = m.scrapReasons.find((r) => r.id === reasonId) ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const blocked = m.scrapMode === "reclassify" && !run;
  // Many reasons: a search; the chosen one always stays in view.
  const [query, setQuery] = useState("");
  const many = m.scrapReasons.length >= SEARCH_FROM;
  const reasons = many && query ? m.scrapReasons.filter((r) => r.id === reasonId || matches(`${r.name} ${r.code}`, query)) : m.scrapReasons;
  const add = (n: number) => setQty((q) => Math.max(1, Math.min(Math.max(1, max), q + n)));

  return (
    <div className="term-pin" role="dialog" aria-modal="true" aria-label={`Selejt — ${m.name}`} onClick={onCancel}>
      <div className="term-sheet tx-scrap" onClick={(e) => e.stopPropagation()}>
        <div className="term-sheet-head">
          <div>
            <div className="term-pin-title">Selejt — {m.name}</div>
            <div className="term-pin-sub">
              {run ? `${run.orderNumber} · ${run.partName} · ` : ""}
              {m.scrapMode === "reclassify" ? "a jó darabok közül vonódik le" : "a gép számlálója mellé, plusz selejtként"}
            </div>
          </div>
          <button type="button" className="term-btn term-btn-ghost" onClick={onCancel}>
            Mégse
          </button>
        </div>
        {blocked ? (
          <p className="term-sub">Nincs futó rendelés ezen a gépen, így nincs miből levonni a selejtet.</p>
        ) : m.scrapReasons.length === 0 ? (
          <p className="term-sub">Ehhez a géphez nincs selejtok felvéve (Admin → Scrap reasons).</p>
        ) : (
          <>
            <div className="tx-scrap-label">1. Mi a selejt oka?</div>
            {many && <TerminalSearch value={query} onChange={setQuery} total={m.scrapReasons.length} found={reasons.length} />}
            <div className="term-sheet-grid tx-scrap-grid" role="radiogroup" aria-label="Selejtok">
              {reasons.map((r) => (
                <button key={r.id} type="button" role="radio" aria-checked={r.id === reasonId} className="term-choice tx-scrap-reason" data-selected={r.id === reasonId ? "true" : undefined} onClick={() => setReasonId(r.id)}>
                  <span className="term-choice-label">{r.name}</span>
                  <span className="term-choice-sub">{r.code}</span>
                </button>
              ))}
            </div>
            <div className="tx-scrap-label">2. Hány darab?</div>
            <div className="tx-scrap-qty">
              <button type="button" className="tx-scrap-step" aria-label="Eggyel kevesebb" onClick={() => add(-1)} disabled={qty <= 1}>
                −
              </button>
              <output className="tx-scrap-value" aria-live="polite">
                {int(qty)} <small>db</small>
              </output>
              <button type="button" className="tx-scrap-step" aria-label="Eggyel több" onClick={() => add(1)} disabled={qty >= max}>
                +
              </button>
              <span className="tx-spacer" />
              {[5, 10].map((n) => (
                <button key={n} type="button" className="tx-scrap-quick" onClick={() => add(n)} disabled={qty >= max}>
                  +{n}
                </button>
              ))}
            </div>
            {m.scrapMode === "reclassify" && <p className="term-sub">Legfeljebb {int(max)} db (ennyi jó darab van a rendelésen).</p>}
            <button type="button" className="term-btn term-btn-primary tx-scrap-submit" disabled={!reason || busy || qty > max || qty < 1} onClick={() => reason && onSubmit(reason, qty)}>
              {reason ? `Lejelentés: ${int(qty)} db — ${reason.name}` : "Válassz okot"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
