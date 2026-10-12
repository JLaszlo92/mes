import { useCallback, useEffect, useRef, useState } from "react";
import InstructionViewer, { VIEWER_LABELS_HU, type ViewerTab } from "./InstructionViewer.js";
import TerminalPinPad from "./TerminalPinPad.js";
import TerminalChoiceSheet from "./TerminalChoiceSheet.js";
import TerminalQualityFlow, { type FlowPurpose } from "./TerminalQualityFlow.js";
import { KIND_LABEL_HU } from "./quality.js";
import { forgetDeviceToken, readDeviceToken, takePairingToken, terminalApi, TerminalError, type TerminalAssignment, type TerminalMachine, type TerminalState, type Worker } from "./terminal-api.js";
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
  "terminal.set_status": "gépállapotot állítani",
  "quality.measure": "mérést rögzíteni",
  "quality.release": "minőségellenőrzést feloldani",
};

/** Built-in statuses (the rest come with their own name from Status definitions). */
const BUILT_IN: Record<string, { label: string; color: string }> = {
  running: { label: "Gyártás", color: "#0b7d33" },
  down: { label: "Leállás", color: "#b3261e" },
  off_shift: { label: "Műszakon kívül", color: "#8a929b" },
};

function statusLook(code: string, m: TerminalMachine): { label: string; color: string } {
  const option = m.statusOptions.find((o) => o.code === code);
  if (option) return { label: option.label, color: option.color ?? "#9a5b00" };
  return BUILT_IN[code] ?? { label: code, color: "#9a5b00" };
}

function clock(iso: string): string {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return today ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/** How often the screen asks for the state; a request still running is not doubled, a hidden tab does not ask. */
const POLL_MS = 2000;
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
  const [sheet, setSheet] = useState<{ kind: "fault" | "status"; machineId: string } | null>(null);
  const [flow, setFlow] = useState<{ checkId: string; orderNumber: string; purpose: FlowPurpose } | null>(null);
  const messageTimer = useRef<number | undefined>(undefined);

  const loading = useRef(false);
  const load = useCallback(() => {
    if (loading.current) return;
    loading.current = true;
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
      })
      .finally(() => {
        loading.current = false;
      });
  }, [terminalUiId]);

  useEffect(() => {
    if (!paired) return;
    load();
    const timer = setInterval(() => document.visibilityState === "visible" && load(), POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
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
      // Another worker may do it (e.g. the quality operator measures while the operator is signed in): ask their code.
      setPending(action);
      setPinError(`${as.name} nem jogosult ${PERMISSION_TEXT[action.permission] ?? "erre"}. Add meg egy jogosult dolgozó kódját.`);
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
            <div className="term-status-row">
              <StatusBadge m={m} />
              <span className="term-spacer" />
              <button type="button" className="term-btn term-btn-alarm" disabled={busy} onClick={() => setSheet({ kind: "fault", machineId: m.id })}>
                Hiba jelentése
              </button>
              <button type="button" className="term-btn" disabled={busy} onClick={() => setSheet({ kind: "status", machineId: m.id })}>
                Státusz
              </button>
            </div>

            {m.current.length === 0 && <p className="term-sub">Nincs ütemezett rendelés.</p>}
            {m.current.map((a) => (
              <OrderRow
                key={a.id}
                a={a}
                order={m.orders[a.workOrderId]}
                busy={busy}
                act={act}
                terminalId={terminalUiId}
                onInstruction={(instruction, tab) => setViewer({ instruction, orderNumber: a.orderNumber, tab })}
                onQuality={(checkId, purpose) => setFlow({ checkId, orderNumber: a.orderNumber, purpose })}
              />
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

            {m.recentReports.length > 0 && <div className="term-sub term-recent">Legutóbbi hibajelentések: {m.recentReports.map((r) => `${r.faultCode} (${r.status})`).join(", ")}</div>}
          </section>
        );
      })}

      {sheet && state && <MachineSheet sheet={sheet} state={state} close={() => setSheet(null)} act={act} terminalId={terminalUiId} flash={flash} />}

      {flow && (
        <TerminalQualityFlow
          key={flow.checkId}
          terminalId={terminalUiId}
          checkId={flow.checkId}
          orderNumber={flow.orderNumber}
          purpose={flow.purpose}
          busy={busy}
          act={act}
          onClose={() => {
            setFlow(null);
            load();
          }}
        />
      )}

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

function StatusBadge({ m }: { m: TerminalMachine }) {
  if (!m.status) return <span className="term-status" style={{ borderColor: "#8a929b" }}>Nincs adat a gépről</span>;
  const look = statusLook(m.status.code, m);
  return (
    <span className="term-status" style={{ borderColor: look.color }}>
      <span className="term-status-dot" style={{ background: look.color }} aria-hidden="true" />
      <span>
        <strong>{look.label}</strong>
        <span className="term-sub">
          {" "}
          · {clock(m.status.since)} óta
          {m.status.manual ? ` · kézzel: ${m.status.manual.setBy ?? "?"}` : ""}
        </span>
        {m.status.manual?.blocksProduction && <span className="term-status-block">Gyártás tiltva — a darabok nem számítanak</span>}
      </span>
    </span>
  );
}

/** The fault list and the status list of one machine; choosing asks the worker's code (via act). */
function MachineSheet({
  sheet,
  state,
  close,
  act,
  terminalId,
  flash,
}: {
  sheet: { kind: "fault" | "status"; machineId: string };
  state: TerminalState;
  close: () => void;
  act: (action: Action) => void;
  terminalId: string;
  flash: (kind: "ok" | "error", text: string) => void;
}) {
  const m = state.machines.find((x) => x.id === sheet.machineId);
  if (!m) return null;

  if (sheet.kind === "fault") {
    return (
      <TerminalChoiceSheet
        title={`Hiba jelentése — ${m.name}`}
        subtitle="Válaszd ki a hiba okát"
        emptyText="Ehhez a géphez nincs felvéve hibaok (Admin → Fault codes)."
        choices={m.faultCodes.map((fc) => ({ key: fc.id, label: fc.code, sub: fc.name, tone: "alarm" as const }))}
        onCancel={close}
        onChoose={(id) => {
          const fc = m.faultCodes.find((x) => x.id === id)!;
          close();
          act({
            title: `Hiba jelentése: ${fc.code} — ${fc.name}`,
            permission: "terminal.report_fault",
            run: async (w) => {
              const r = await terminalApi.reportFault(terminalId, w.ticket, m.id, fc.id);
              flash("ok", `Lejelentve: ${fc.code} — ${fc.name} (${w.name})`);
              return r.workerExpiresAt;
            },
          });
        }}
      />
    );
  }

  const manual = m.status?.manual;
  return (
    <TerminalChoiceSheet
      title={`Státusz — ${m.name}`}
      subtitle={
        manual
          ? "A kézi állapot addig marad, amíg le nem zárod; ha nem tiltja a gyártást, a gép első gyártási jelére is véget ér."
          : "Ha az állapot nem tiltja a gyártást, a gép első gyártási jelére véget ér; ha tiltja, csak lezárással."
      }
      emptyText="Nincs beállítható állapot (Admin → Status definitions)."
      choices={m.statusOptions.map((o) => ({
        key: o.code,
        label: o.label,
        sub: `${o.oeeCategory === "excluded" ? "tervezett, nem rontja az OEE-t" : "leállásnak számít"}${o.blocksProduction ? " · gyártás tiltva" : ""}`,
        color: o.color,
      }))}
      footer={
        manual ? (
          <button
            type="button"
            className="term-btn"
            onClick={() => {
              close();
              act({
                title: `Kézi állapot lezárása — ${m.name}`,
                permission: "terminal.set_status",
                run: async (w) => {
                  const r = await terminalApi.endStatus(terminalId, w.ticket, m.id);
                  flash("ok", `${m.name}: vissza a gép jeléhez (${w.name})`);
                  return r.workerExpiresAt;
                },
              });
            }}
          >
            Kézi állapot lezárása — vissza a gép jeléhez
          </button>
        ) : undefined
      }
      onCancel={close}
      onChoose={(code) => {
        const o = m.statusOptions.find((x) => x.code === code)!;
        close();
        act({
          title: `Státusz: ${o.label} — ${m.name}`,
          permission: "terminal.set_status",
          run: async (w) => {
            const r = await terminalApi.setStatus(terminalId, w.ticket, m.id, o.code);
            flash("ok", `${m.name}: ${o.label} (${w.name})`);
            return r.workerExpiresAt;
          },
        });
      }}
    />
  );
}

function OrderRow({
  a,
  order,
  busy,
  act,
  terminalId,
  onInstruction,
  onQuality,
}: {
  a: TerminalAssignment;
  order: TerminalState["machines"][number]["orders"][string] | undefined;
  busy: boolean;
  act: (action: Action) => void;
  terminalId: string;
  onInstruction: (instruction: WorkInstruction, tab: ViewerTab) => void;
  onQuality: (checkId: string, purpose: FlowPurpose) => void;
}) {
  const running = a.workOrderStatus === "in_progress";
  const progress = order?.progress;
  const instruction = order?.instruction;
  const quality = order?.quality ?? null;

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
                run: async (w) => {
                  try {
                    return (await terminalApi.complete(terminalId, w.ticket, a.workOrderId)).workerExpiresAt;
                  } catch (err) {
                    // A last-piece check comes first: the measurement opens; it closes the order at the end.
                    if (err instanceof TerminalError && (err.code === "quality_check_required" || err.code === "quality_check_offered") && typeof err.data.checkId === "string") {
                      onQuality(err.data.checkId, { kind: "complete", workOrderId: a.workOrderId, gating: err.code === "quality_check_required" });
                      return;
                    }
                    throw err;
                  }
                },
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
      {running && quality && (
        <div className="term-quality">
          {quality.hold && (
            <div className="term-quality-hold" role="status">
              {quality.hold.reason === "first_piece" ? "Első darab mérés szükséges — addig a darabok nem számítanak" : "Tűrésen kívüli mérés — a darabszámlálás szünetel, amíg az újramérés meg nem felel"}
            </div>
          )}
          <div className="term-quality-row">
            {quality.checks.map((c) => (
              <button
                key={c.id}
                type="button"
                className="term-btn term-quality-btn"
                data-state={c.status === "failed" ? "fail" : c.overdue ? "late" : "due"}
                disabled={busy}
                onClick={() => onQuality(c.id, { kind: "check" })}
              >
                Mérés: {KIND_LABEL_HU[c.kind]}
                <small>
                  {c.passedCount} / {c.total} kész{c.status === "failed" ? " · tűrésen kívül" : c.overdue ? " · késésben" : ""}
                </small>
              </button>
            ))}
            {quality.planVersion !== null && !quality.checks.some((c) => c.kind === "spot") && (
              <button
                type="button"
                className="term-btn term-btn-soft"
                disabled={busy}
                onClick={() =>
                  act({
                    title: `Szúrópróba most: ${a.orderNumber}`,
                    permission: "quality.measure",
                    run: async (w) => {
                      const r = await terminalApi.requestSpotCheck(terminalId, w.ticket, a.workOrderId);
                      onQuality(r.checkId, { kind: "check" });
                      return r.workerExpiresAt;
                    },
                  })
                }
              >
                Szúrópróba most
              </button>
            )}
            {quality.checks.length === 0 && (
              <span className="term-sub">
                Minőség: rendben
                {quality.spot?.enabled ? ` · szúrópróba ${[quality.spot.everyParts && `${quality.spot.everyParts} db`, quality.spot.maxMinutes && `legkésőbb ${quality.spot.maxMinutes} perc`].filter(Boolean).join(" / ")}` : ""}
              </span>
            )}
          </div>
        </div>
      )}
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
