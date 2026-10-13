import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { VIEWER_LABELS_HU } from "./InstructionViewer.js";
import { fmt, KIND_LABEL_HU, type CheckDetail } from "./quality.js";
import { terminalApi, type OrderReport, type Worker } from "./terminal-api.js";

const PdfViewer = lazy(() => import("./ui/PdfViewer.js"));

export interface FlowAction {
  title: string;
  permission: string;
  run: (worker: Worker) => Promise<number | void>;
}

/** What the flow is for: an ordinary check, or the last piece before completing the order. */
/** "complete": the last-piece check before completing; the report the worker gave goes with the completion at the end. */
export type FlowPurpose = { kind: "check" } | { kind: "complete"; workOrderId: string; gating: boolean; report: OrderReport };

const hu = (n: number | null) => (n === null ? "—" : fmt(n).replace(".", ","));

function limitsText(c: { kind: string; lowerLimit: number | null; upperLimit: number | null; unit: string | null }) {
  if (c.kind === "attribute") return "Megfelelő / nem megfelelő";
  const u = c.unit ? ` ${c.unit}` : "";
  if (c.lowerLimit !== null && c.upperLimit !== null) return `${hu(c.lowerLimit)} … ${hu(c.upperLimit)}${u}`;
  if (c.upperLimit !== null) return `legfeljebb ${hu(c.upperLimit)}${u}`;
  return `legalább ${hu(c.lowerLimit)}${u}`;
}

/**
 * Mérés a terminálon: egyszerre egy jellemző, a hozzá tartozó PDF-fel, a
 * tűréshatárokkal és egy nagy számbillentyűzettel. A rögzítés a dolgozó
 * kódjával megy (quality.measure); tűrésen kívüli értéknél ugyanaz a jellemző
 * marad soron (újramérés), és a quality supervisor indoklással feloldhatja.
 */
export default function TerminalQualityFlow({
  terminalId,
  checkId,
  orderNumber,
  purpose,
  busy,
  act,
  onClose,
}: {
  terminalId: string;
  checkId: string;
  orderNumber: string;
  purpose: FlowPurpose;
  busy: boolean;
  act: (action: FlowAction) => void;
  onClose: () => void;
}) {
  const [check, setCheck] = useState<CheckDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entry, setEntry] = useState("");
  const [last, setLast] = useState<{ name: string; text: string; passed: boolean } | null>(null);
  const [releasing, setReleasing] = useState(false);
  const [reason, setReason] = useState("");
  const [showPdf, setShowPdf] = useState(true);

  const reload = useCallback(() => {
    terminalApi
      .qualityCheck(terminalId, checkId)
      .then((c) => {
        setCheck(c);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [terminalId, checkId]);

  useEffect(reload, [reload]);

  const active = check && (check.status === "open" || check.status === "failed");
  const item = check?.items.find((i) => i.id === check.nextCharacteristicId) ?? null;
  const index = item && check ? check.items.indexOf(item) : -1;
  const failedNow = item ? item.attempts.length > 0 && !item.attempts.at(-1)!.passed : false;

  function key(k: string) {
    setEntry((e) => {
      if (k === "⌫") return e.slice(0, -1);
      if (k === ",") return e.includes(",") ? e : (e === "" || e === "-" ? `${e}0` : e) + ",";
      if (k === "±") return e.startsWith("-") ? e.slice(1) : `-${e}`;
      if (e.replace("-", "").replace(",", "").length >= 10) return e;
      return e + k;
    });
  }

  function submit(body: { value?: number; ok?: boolean }) {
    if (!item) return;
    const text = item.kind === "attribute" ? (body.ok ? "Megfelelő" : "Nem megfelelő") : `${entry}${item.unit ? ` ${item.unit}` : ""}`;
    act({
      title: `Mérés: ${item.name} = ${text}`,
      permission: "quality.measure",
      run: async (w) => {
        const r = await terminalApi.measure(terminalId, w.ticket, checkId, { characteristicId: item.id, ...body });
        setLast({ name: item.name, text, passed: r.passed });
        setCheck(r.check);
        setEntry("");
        return r.workerExpiresAt;
      },
    });
  }

  function release() {
    act({
      title: `Feloldás: ${KIND_LABEL_HU[check!.kind]} — ${orderNumber}`,
      permission: "quality.release",
      run: async (w) => {
        const r = await terminalApi.releaseCheck(terminalId, w.ticket, checkId, reason.trim());
        setReleasing(false);
        setReason("");
        reload();
        return r.workerExpiresAt;
      },
    });
  }

  function complete(skip: boolean) {
    if (purpose.kind !== "complete") return;
    act({
      title: skip ? `Utolsó darab kihagyása, lezárás: ${orderNumber}` : `Rendelés lezárása: ${orderNumber}`,
      permission: "terminal.complete_work_order",
      run: async (w) => {
        const r = await terminalApi.complete(terminalId, w.ticket, purpose.workOrderId, purpose.report, skip);
        onClose();
        return r.workerExpiresAt;
      },
    });
  }

  const value = Number(entry.replace(",", "."));
  const canSubmit = item?.kind === "variable" ? entry !== "" && entry !== "-" && Number.isFinite(value) : false;
  const done = check && !active;
  const pdfId = item?.pdfFileId ?? null;

  return (
    <div className="term-qf" role="dialog" aria-modal="true" aria-label={`Mérés — ${orderNumber}`}>
      <header className="term-qf-head">
        <div>
          <div className="term-pin-title">
            {check ? KIND_LABEL_HU[check.kind] : "Mérés"} — {orderNumber}
          </div>
          <div className="term-sub">
            {check ? `${check.partName} · ${check.machineName ?? ""} · terv v${check.planVersion}` : ""}
            {check?.gating && active ? (check.kind === "first_piece" ? " · amíg nincs kész, a darabok nem számítanak" : " · a rendelés csak utána zárható le") : ""}
          </div>
        </div>
        <span className="term-spacer" />
        {pdfId && active && (
          <button type="button" className="term-btn term-btn-soft" onClick={() => setShowPdf((s) => !s)}>
            {showPdf ? "Rajz elrejtése" : "Rajz mutatása"}
          </button>
        )}
        <button type="button" className="term-btn term-btn-ghost" onClick={onClose}>
          Bezárás
        </button>
      </header>

      {error && <div className="term-flash term-flash-error">{error}</div>}
      {!check && !error && <p className="term-sub">Betöltés…</p>}

      {check && (
        <div className="term-qf-steps" aria-label="Mérések">
          {check.items.map((i, n) => {
            const lastAttempt = i.attempts.at(-1);
            const state = i.id === check.nextCharacteristicId ? "current" : lastAttempt?.passed ? "ok" : lastAttempt ? "fail" : "todo";
            return (
              <span key={i.id} className="term-qf-step" data-state={state}>
                {n + 1}. {i.name}
              </span>
            );
          })}
        </div>
      )}

      {last && (
        <div className={`term-qf-result term-qf-result-${last.passed ? "ok" : "fail"}`} role="status">
          {last.passed ? "✓ Megfelelő" : "✗ Tűrésen kívül"}: {last.name} = {last.text}
          {!last.passed && " — a darabszámlálás szünetel. Mérd újra, vagy kérj feloldást."}
        </div>
      )}

      {done && (
        <div className="term-qf-done">
          <h2>{check.status === "passed" ? "Az ellenőrzés rendben" : check.status === "released" ? "Az ellenőrzést feloldották" : "Az ellenőrzés lezárult"}</h2>
          {check.releaseReason && <p className="term-sub">Indoklás: {check.releaseReason}</p>}
          {purpose.kind === "complete" ? (
            <button type="button" className="term-btn term-btn-done term-qf-big" disabled={busy} onClick={() => complete(false)}>
              Rendelés lezárása
            </button>
          ) : (
            <button type="button" className="term-btn term-btn-primary term-qf-big" onClick={onClose}>
              Kész
            </button>
          )}
        </div>
      )}

      {active && item && (
        <div className="term-qf-body" data-pdf={pdfId && showPdf ? "true" : undefined}>
          {pdfId && showPdf && (
            <div className="term-qf-pdf">
              <Suspense fallback={<div className="ui-pdf-state">{VIEWER_LABELS_HU.pdf.loading}</div>}>
                <PdfViewer fileId={pdfId} source={terminalApi.fileSource(terminalId, pdfId)} labels={VIEWER_LABELS_HU.pdf} />
              </Suspense>
            </div>
          )}
          <div className="term-qf-panel">
            <div className="term-sub">
              Mérés {index + 1} / {check!.items.length}
              {failedNow ? ` · ${item.attempts.length + 1}. próbálkozás` : ""}
            </div>
            <h2 className="term-qf-name">{item.name}</h2>
            {item.method && <div className="term-sub">Mérőeszköz: {item.method}</div>}
            {item.kind === "variable" ? (
              <>
                <div className="term-qf-limits">
                  <span>
                    <small>Alsó</small>
                    {hu(item.lowerLimit)}
                  </span>
                  <span>
                    <small>Névleges</small>
                    {hu(item.nominal)}
                  </span>
                  <span>
                    <small>Felső</small>
                    {hu(item.upperLimit)}
                  </span>
                  <span>
                    <small>Egység</small>
                    {item.unit ?? "—"}
                  </span>
                </div>
                <div className="term-qf-entry" aria-live="polite" data-empty={entry === "" ? "true" : undefined}>
                  {entry === "" ? "Mért érték" : entry}
                  {entry !== "" && item.unit ? <small> {item.unit}</small> : null}
                </div>
                <div className="term-qf-keys">
                  {["7", "8", "9", "4", "5", "6", "1", "2", "3", "±", "0", ","].map((k) => (
                    <button key={k} type="button" className="term-key" onClick={() => key(k)}>
                      {k}
                    </button>
                  ))}
                  <button type="button" className="term-key" onClick={() => key("⌫")} aria-label="Törlés">
                    ⌫
                  </button>
                  <button type="button" className="term-btn term-btn-primary term-qf-submit" disabled={!canSubmit || busy} onClick={() => submit({ value })}>
                    Rögzítés
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="term-sub">Elvárás: {limitsText(item)}</p>
                <div className="term-qf-attr">
                  <button type="button" className="term-btn term-btn-done term-qf-big" disabled={busy} onClick={() => submit({ ok: true })}>
                    Megfelelő
                  </button>
                  <button type="button" className="term-btn term-btn-alarm term-qf-big" disabled={busy} onClick={() => submit({ ok: false })}>
                    Nem megfelelő
                  </button>
                </div>
              </>
            )}

            <div className="term-qf-foot">
              {purpose.kind === "complete" && !purpose.gating && (
                <button type="button" className="term-btn term-btn-ghost" disabled={busy} onClick={() => complete(true)}>
                  Kihagyás és lezárás
                </button>
              )}
              {(check!.status === "failed" || check!.gating) && !releasing && (
                <button type="button" className="term-btn term-btn-ghost" onClick={() => setReleasing(true)}>
                  Feloldás (quality supervisor)…
                </button>
              )}
            </div>
            {releasing && (
              <div className="term-qf-release">
                <label className="term-sub" htmlFor="qf-reason">
                  A feloldás indoka (megmarad az ellenőrzésnél)
                </label>
                <textarea id="qf-reason" className="term-textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="pl. eltérési engedély száma, mérőeszköz kalibrálás alatt…" />
                <div className="term-qf-attr">
                  <button type="button" className="term-btn term-btn-ghost" onClick={() => setReleasing(false)}>
                    Mégse
                  </button>
                  <button type="button" className="term-btn term-btn-primary" disabled={reason.trim().length < 3 || busy} onClick={release}>
                    Feloldás
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
