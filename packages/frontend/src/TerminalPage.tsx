import { useCallback, useEffect, useRef, useState } from "react";
import InstructionViewer, { VIEWER_LABELS_HU, type ViewerTab } from "./InstructionViewer.js";
import TerminalPinPad from "./TerminalPinPad.js";
import { forgetDeviceToken, readDeviceToken, takePairingToken, terminalApi, TerminalError, type TerminalAssignment, type TerminalState, type Worker } from "./terminal-api.js";
import type { WorkInstruction } from "./work-instructions.js";

/**
 * A gép melletti terminál. Bejelentkezés nélkül fut (a párosított eszköz
 * tokenjével, újraindítás után is), mindenki láthatja. Minden változtatás —
 * rendelés indítása és lezárása, hibajelentés, munkautasítás megnyitása — a
 * dolgozó személyes kódját kéri; a kód után 60 másodpercig (minden
 * művelettel újrakezdve) nem kell újra beírni, és a művelet az ő nevén fut.
 */

interface Action {
  /** What the pin pad says, e.g. "Rendelés indítása: WO-1". */
  title: string;
  permission: string;
  run: (worker: Worker) => Promise<number | void>;
}

const PERMISSION_TEXT: Record<string, string> = {
  "terminal.start_work_order": "rendelést indítani",
  "terminal.complete_work_order": "rendelést lezárni",
  "terminal.report_fault": "hibát jelenteni",
  "terminal.open_instructions": "munkautasítást megnyitni",
};

const POLL_MS = 5000;
/** Same as the server (terminal-workers.ts). Counted on this device's clock: a tablet with a wrong clock still counts right; the server decides anyway. */
const WORKER_IDLE_MS = 60_000;

export default function TerminalPage({ terminalUiId }: { terminalUiId: string }) {
  const [paired, setPaired] = useState(() => {
    takePairingToken(terminalUiId);
    return readDeviceToken(terminalUiId) !== null;
  });
  const [state, setState] = useState<TerminalState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [worker, setWorker] = useState<Worker | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState<Action | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [viewer, setViewer] = useState<{ instruction: WorkInstruction; orderNumber: string; tab: ViewerTab } | null>(null);
  const [showHistoryFor, setShowHistoryFor] = useState<Record<string, boolean>>({});
  const messageTimer = useRef<number | undefined>(undefined);

  const load = useCallback(() => {
    terminalApi
      .state(terminalUiId)
      .then((s) => {
        setState(s);
        setLoadError(null);
      })
      .catch((err) => {
        if (err instanceof TerminalError && err.code === "terminal_not_paired") {
          forgetDeviceToken(terminalUiId);
          setPaired(false);
        } else setLoadError(err instanceof Error ? err.message : String(err));
      });
  }, [terminalUiId]);

  useEffect(() => {
    if (!paired) return;
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [paired, load]);

  // The countdown of the signed-in worker; at zero the terminal locks itself.
  useEffect(() => {
    if (!worker) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [worker]);
  useEffect(() => {
    if (worker && now >= worker.expiresAt) setWorker(null);
  }, [now, worker]);

  function flash(kind: "ok" | "error", text: string) {
    setMessage({ kind, text });
    window.clearTimeout(messageTimer.current);
    messageTimer.current = window.setTimeout(() => setMessage(null), kind === "ok" ? 4000 : 8000);
  }

  async function execute(action: Action, as: Worker) {
    if (!as.permissions.includes(action.permission)) {
      flash("error", `${as.name} nem jogosult ${PERMISSION_TEXT[action.permission] ?? "erre"}. Másik dolgozó kódjával próbáld.`);
      return;
    }
    setBusy(true);
    try {
      const done = await action.run(as);
      if (typeof done === "number") setWorker({ ...as, expiresAt: Date.now() + WORKER_IDLE_MS });
      load();
    } catch (err) {
      if (err instanceof TerminalError && err.code === "worker_required") {
        setWorker(null);
        setPending(action);
        setPinError("A belépés lejárt, add meg újra a kódodat.");
      } else if (err instanceof TerminalError && err.code === "terminal_not_paired") {
        setPaired(false);
      } else flash("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** Every change goes through here: with a signed-in worker it runs, otherwise the code is asked first. */
  function act(action: Action) {
    if (busy) return;
    if (worker && Date.now() < worker.expiresAt) void execute(action, worker);
    else {
      setPinError(null);
      setPending(action);
    }
  }

  async function submitPin(pin: string) {
    if (!pending) return;
    setPinBusy(true);
    setPinError(null);
    try {
      const w = { ...(await terminalApi.unlock(terminalUiId, pin)), expiresAt: Date.now() + WORKER_IDLE_MS };
      setWorker(w);
      setNow(Date.now());
      const action = pending;
      setPending(null);
      if (action.permission !== "") await execute(action, w);
    } catch (err) {
      if (err instanceof TerminalError && err.code === "wrong_pin") setPinError("Hibás kód.");
      else if (err instanceof TerminalError && err.code === "locked") setPinError("Túl sok hibás kód. Várj néhány percet, utána próbáld újra.");
      else if (err instanceof TerminalError && err.code === "permission") setPinError(`${err.message.split(" has no ")[0]} nem dolgozhat a terminálon (nincs jogosultsága).`);
      else setPinError(err instanceof Error ? err.message : String(err));
    } finally {
      setPinBusy(false);
    }
  }

  function signOut() {
    if (worker) void terminalApi.lock(terminalUiId, worker.ticket);
    setWorker(null);
  }

  if (!paired) {
    return (
      <div className="term">
        <div className="term-notice">
          <h1>Ez a képernyő nincs párosítva</h1>
          <p>
            A terminál használatához egy adminisztrátornak párosítania kell ezt az eszközt: a dashboardon Admin → Terminals → <strong>Pair device</strong>, majd
            a megjelenő linket (QR-kódot) ezen az eszközön kell megnyitni. Egyszer kell megtenni; újraindítás után is megmarad.
          </p>
        </div>
      </div>
    );
  }

  const secondsLeft = worker ? Math.max(0, Math.ceil((worker.expiresAt - now) / 1000)) : 0;

  return (
    <div className="term">
      <header className="term-head">
        <h1>{state?.terminal.name ?? "Terminál"}</h1>
        <span className="term-spacer" />
        {worker ? (
          <div className="term-worker">
            <span>
              <strong>{worker.name}</strong>
              <span className="term-sub">
                {worker.roleName} · még {secondsLeft} mp
              </span>
            </span>
            <button type="button" className="term-btn term-btn-ghost" onClick={signOut}>
              Kilépés
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="term-btn term-btn-ghost"
            onClick={() => {
              setPinError(null);
              setPending({ title: "Belépés", permission: "", run: async () => undefined });
            }}
          >
            Belépés kóddal
          </button>
        )}
      </header>

      {message && <div className={`term-flash term-flash-${message.kind}`}>{message.kind === "ok" ? "✓ " : ""}{message.text}</div>}
      {loadError && <div className="term-flash term-flash-error">Nincs kapcsolat a szerverrel: {loadError}</div>}
      {!state && !loadError && <p className="term-sub">Betöltés…</p>}

      {state?.machines.map((m) => {
        const showHistory = showHistoryFor[m.id] ?? false;
        return (
          <section key={m.id} className="term-machine">
            <div className="term-machine-head">
              <h2>{m.name}</h2>
              {m.shift && (
                <div className="term-shift">
                  <span>
                    Műszak: <strong>{m.shift.shiftName}</strong>
                  </span>
                  <span>
                    Jó: <strong>{m.shift.goodCount}</strong>
                  </span>
                  <span>
                    Selejt: <strong className="term-scrap">{m.shift.scrapCount}</strong>
                  </span>
                  <span>
                    OEE: <strong>{m.shift.oee !== null ? `${Math.round(m.shift.oee * 100)}%` : "—"}</strong>
                  </span>
                </div>
              )}
            </div>

            {m.current.length === 0 && <p className="term-sub">Nincs ütemezett rendelés.</p>}
            {m.current.map((a) => (
              <OrderRow key={a.id} a={a} order={m.orders[a.workOrderId]} busy={busy} act={act} terminalId={terminalUiId} onInstruction={(instruction, tab) => setViewer({ instruction, orderNumber: a.orderNumber, tab })} />
            ))}

            {m.history.length > 0 && (
              <div className="term-history">
                <button type="button" className="term-btn term-btn-ghost term-btn-small" onClick={() => setShowHistoryFor((p) => ({ ...p, [m.id]: !showHistory }))}>
                  {showHistory ? "Korábbiak elrejtése" : `Korábbiak (${m.history.length})`}
                </button>
                {showHistory &&
                  m.history.map((a) => (
                    <div key={a.id} className="term-order term-order-done">
                      <div className="term-order-main">
                        <div className="term-order-title">
                          {a.orderNumber} — {a.partName}
                        </div>
                        <div className="term-sub">
                          {a.quantity} db · {a.workOrderStatus === "completed" ? "Kész" : "Törölve"}
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            )}

            {m.faultCodes.length > 0 && (
              <div className="term-faults">
                <div className="term-sub">Hiba jelentése</div>
                <div className="term-fault-buttons">
                  {m.faultCodes.map((fc) => (
                    <button
                      key={fc.id}
                      type="button"
                      className="term-fault"
                      disabled={busy}
                      onClick={() =>
                        act({
                          title: `Hiba jelentése: ${fc.code} — ${fc.name}`,
                          permission: "terminal.report_fault",
                          run: async (w) => {
                            const r = await terminalApi.reportFault(terminalUiId, w.ticket, m.id, fc.id);
                            flash("ok", `Lejelentve: ${fc.code} — ${fc.name} (${w.name})`);
                            return r.workerExpiresAt;
                          },
                        })
                      }
                    >
                      {fc.code}
                      <span>{fc.name}</span>
                    </button>
                  ))}
                </div>
                {m.recentReports.length > 0 && <div className="term-sub">Legutóbbi: {m.recentReports.map((r) => `${r.faultCode} (${r.status})`).join(", ")}</div>}
              </div>
            )}
          </section>
        );
      })}

      {pending && <TerminalPinPad title={pending.title} error={pinError} busy={pinBusy} onSubmit={(pin) => void submitPin(pin)} onCancel={() => setPending(null)} />}

      {viewer && (
        <InstructionViewer
          key={`${viewer.instruction.id}:${viewer.orderNumber}`}
          instruction={viewer.instruction}
          subtitle={viewer.orderNumber}
          initialTab={viewer.tab}
          labels={VIEWER_LABELS_HU}
          large
          pdfSource={(fileId) => terminalApi.fileSource(terminalUiId, fileId)}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}

function OrderRow({
  a,
  order,
  busy,
  act,
  terminalId,
  onInstruction,
}: {
  a: TerminalAssignment;
  order: TerminalState["machines"][number]["orders"][string] | undefined;
  busy: boolean;
  act: (action: Action) => void;
  terminalId: string;
  onInstruction: (instruction: WorkInstruction, tab: ViewerTab) => void;
}) {
  const running = a.workOrderStatus === "in_progress";
  const progress = order?.progress;
  const instruction = order?.instruction;

  function openInstruction(tab: ViewerTab) {
    act({
      title: `Munkautasítás: ${a.orderNumber}`,
      permission: "terminal.open_instructions",
      run: async (w) => {
        const r = await terminalApi.openInstruction(terminalId, w.ticket, a.workOrderId);
        onInstruction(r.instruction, tab);
        return r.workerExpiresAt;
      },
    });
  }

  return (
    <div className="term-order">
      <div className="term-order-row">
        <div className="term-order-main">
          <div className="term-order-title">
            {a.orderNumber} — {a.partName}
          </div>
          <div className="term-sub">
            {a.quantity} db · {new Date(a.plannedStart).toLocaleString()} → {new Date(a.plannedEnd).toLocaleString()}
          </div>
          {running && progress && (
            <div className="term-progress" data-done={progress.targetReached ? "true" : undefined}>
              {progress.goodCount} / {progress.quantity} db kész{progress.targetReached ? " — célmennyiség elérve" : ` — ${progress.remaining} hátra`}
              {progress.operator ? <span className="term-sub"> · indította: {progress.operator}</span> : null}
            </div>
          )}
        </div>
        {running ? (
          <button
            type="button"
            className="term-btn term-btn-done"
            disabled={busy}
            onClick={() =>
              act({
                title: `Rendelés lezárása: ${a.orderNumber}`,
                permission: "terminal.complete_work_order",
                run: async (w) => (await terminalApi.complete(terminalId, w.ticket, a.workOrderId)).workerExpiresAt,
              })
            }
          >
            Befejezés
          </button>
        ) : (
          <button
            type="button"
            className="term-btn term-btn-primary"
            disabled={busy}
            onClick={() =>
              act({
                title: `Rendelés indítása: ${a.orderNumber}`,
                permission: "terminal.start_work_order",
                run: async (w) => (await terminalApi.start(terminalId, w.ticket, a.workOrderId)).workerExpiresAt,
              })
            }
          >
            Elkezdés
          </button>
        )}
      </div>
      {running && instruction && (
        <div className="term-instruction">
          <button type="button" className="term-btn term-btn-soft" disabled={busy} onClick={() => openInstruction("text")}>
            Munkautasítás
          </button>
          {instruction.hasPdf && (
            <button type="button" className="term-btn term-btn-soft" disabled={busy} onClick={() => openInstruction("pdf")}>
              PDF megnyitása
            </button>
          )}
          <span className="term-sub">
            {instruction.partName} · v{instruction.version}
          </span>
        </div>
      )}
    </div>
  );
}
