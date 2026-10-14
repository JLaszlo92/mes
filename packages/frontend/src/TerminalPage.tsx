import { useCallback, useEffect, useRef, useState } from "react";
import "@fontsource/barlow/400.css";
import "@fontsource/barlow/500.css";
import "@fontsource/barlow/600.css";
import "@fontsource/barlow/700.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import InstructionViewer, { VIEWER_LABELS_HU, type ViewerTab } from "./InstructionViewer.js";
import TerminalPinPad from "./TerminalPinPad.js";
import TerminalChoiceSheet from "./TerminalChoiceSheet.js";
import TerminalQualityFlow, { type FlowPurpose } from "./TerminalQualityFlow.js";
import TerminalMachineView, { type MachineActions } from "./TerminalMachineView.js";
import TerminalOverview from "./TerminalOverview.js";
import TerminalScrapSheet from "./TerminalScrapSheet.js";
import TerminalReportSheet from "./TerminalReportSheet.js";
import { IconChevronLeft, IconLock, IconMoon, IconSun } from "./TerminalIcons.js";
import { KIND_LABEL_HU } from "./quality.js";
import { forgetDeviceToken, readDeviceToken, takePairingToken, terminalApi, TerminalError, type OrderReport, type TerminalAssignment, type TerminalMachine, type TerminalState, type Worker } from "./terminal-api.js";
import { hhmm, int, isPaused, plannedText, runningOrder, shortTime, statusView, waitingOrders, waitingText } from "./terminal-model.js";
import type { WorkInstruction } from "./work-instructions.js";

/**
 * A gép melletti terminál. Bejelentkezés nélkül fut (a párosított eszköz
 * tokenjével, újraindítás után is), mindenki láthatja. Minden változtatás a
 * dolgozó személyes kódját kéri; a kód után 60 másodpercig (minden
 * művelettel újrakezdve) nem kell újra beírni, és a művelet az ő nevén fut.
 *
 * Elrendezés a gépek számától függ: 1 gép → a gép képernyője; 2–4 →
 * csempés áttekintés; 5+ → lista. Több gépnél a gép képernyője koppintásra
 * nyílik, és 90 mp tétlenség után visszaáll az áttekintésre.
 */

interface Action {
  /** What the pin pad says, e.g. "Rendelés indítása: WO-1". */
  title: string;
  permission: string;
  run: (worker: Worker) => Promise<number | void>;
}

type Sheet =
  | { kind: "fault" | "status" | "history" | "scrap"; machineId: string }
  | { kind: "start" | "complete" | "measure"; machineId: string }
  | { kind: "report"; machineId: string; workOrderId: string; intent: "complete" | "pause" };

const PERMISSION_TEXT: Record<string, string> = {
  "terminal.start_work_order": "rendelést indítani",
  "terminal.complete_work_order": "rendelést lezárni",
  "terminal.report_fault": "hibát jelenteni",
  "terminal.open_instructions": "munkautasítást megnyitni",
  "terminal.set_status": "gépállapotot állítani",
  "quality.measure": "mérést rögzíteni",
  "terminal.report_scrap": "selejtet jelenteni",
  "quality.release": "minőségellenőrzést feloldani",
};

/** How often the screen asks for the state; a request still running is not doubled, a hidden tab does not ask. */
const POLL_MS = 2000;
/** Same as the server (terminal-workers.ts). Counted on this device's clock: a tablet with a wrong clock still counts right; the server decides anyway. */
const WORKER_IDLE_MS = 60_000;
/** With several machines, an open machine screen goes back to the overview after this long without a touch. */
const BACK_TO_OVERVIEW_MS = 90_000;
const THEME_KEY = "mes-terminal-theme";
/** How often the screen looks for a new version of itself. */
const VERSION_CHECK_MS = 120_000;

function readTheme(): "dark" | "light" {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

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
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [flow, setFlow] = useState<{ checkId: string; orderNumber: string; purpose: FlowPurpose } | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(readTheme);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const lastTouch = useRef(Date.now());
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

  // A new version on the server (after an update): the screen reloads itself when nobody is using it, so a
  // terminal never keeps running old code for days.
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => {
    const loaded = [...document.querySelectorAll<HTMLScriptElement>("script[src]")].map((x) => x.src.match(/\/assets\/index-[\w-]+\.js/)?.[0]).find(Boolean);
    if (!loaded) return;
    const check = () =>
      fetch(`${window.location.origin}/?v=${Date.now()}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.text() : ""))
        .then((html) => {
          const current = html.match(/\/assets\/index-[\w-]+\.js/)?.[0];
          if (current && current !== loaded) setUpdateReady(true);
        })
        .catch(() => undefined);
    const timer = setInterval(check, VERSION_CHECK_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (updateReady && !worker && !pending && !sheet && !flow && !viewer) window.location.reload();
  }, [updateReady, worker, pending, sheet, flow, viewer]);

  // The clock (and the worker's countdown, every second while someone is signed in).
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), worker ? 1000 : 10_000);
    return () => clearInterval(timer);
  }, [worker]);
  useEffect(() => {
    if (worker && now >= worker.expiresAt) setWorker(null);
  }, [now, worker]);

  // Several machines: an open machine screen goes back to the overview when nobody touches it.
  useEffect(() => {
    const touch = () => (lastTouch.current = Date.now());
    window.addEventListener("pointerdown", touch);
    return () => window.removeEventListener("pointerdown", touch);
  }, []);
  const modalOpen = pending !== null || flow !== null || sheet !== null || viewer !== null;
  useEffect(() => {
    if (selectedId && !modalOpen && now - lastTouch.current > BACK_TO_OVERVIEW_MS) setSelectedId(null);
  }, [now, selectedId, modalOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // per-device convenience only
    }
  }, [theme]);

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

  // ---- machine actions ----

  function startOrder(a: TerminalAssignment) {
    const resume = isPaused(a);
    act({
      title: `${resume ? "Megbízás folytatása" : "Rendelés indítása"}: ${a.orderNumber} — ${a.partName}`,
      permission: "terminal.start_work_order",
      run: async (w) => {
        const r = await terminalApi.start(terminalUiId, w.ticket, a.workOrderId);
        flash("ok", `${resume ? "Folytatva" : "Elindítva"}: ${a.orderNumber} (${w.name})`);
        return r.workerExpiresAt;
      },
    });
  }

  /** Befejezés: the report dialog first (good count, scrap by reason); it completes or pauses the order. */
  function completeOrder(a: TerminalAssignment, machineId: string, intent: "complete" | "pause" = "complete") {
    setSheet({ kind: "report", machineId, workOrderId: a.workOrderId, intent });
  }

  function sendReport(a: TerminalAssignment, report: OrderReport, outcome: "completed" | "paused") {
    act({
      title: `${outcome === "completed" ? "Lezárás" : "Szüneteltetés"}: ${a.orderNumber} — ${int(report.good)} jó${report.scrap.length ? `, +${int(report.scrap.reduce((x, l) => x + l.quantity, 0))} selejt` : ""}`,
      permission: "terminal.complete_work_order",
      run: async (w) => {
        try {
          const r = await terminalApi.complete(terminalUiId, w.ticket, a.workOrderId, report);
          flash(
            "ok",
            r.status === "completed"
              ? `Lezárva: ${a.orderNumber} — ${int(r.report.totalGood)} / ${int(r.report.quantity)} db (${w.name})`
              : `Szüneteltetve: ${a.orderNumber} — ${int(r.report.totalGood)} / ${int(r.report.quantity)} db kész (${w.name})`,
          );
          return r.workerExpiresAt;
        } catch (err) {
          // A last-piece check comes first: the measurement opens; it completes the order at the end with this report.
          if (err instanceof TerminalError && (err.code === "quality_check_required" || err.code === "quality_check_offered") && typeof err.data.checkId === "string") {
            setFlow({ checkId: err.data.checkId, orderNumber: a.orderNumber, purpose: { kind: "complete", workOrderId: a.workOrderId, gating: err.code === "quality_check_required", report } });
            return;
          }
          throw err;
        }
      },
    });
  }

  function openInstruction(m: TerminalMachine) {
    const a = runningOrder(m);
    if (!a) return;
    act({
      title: `Munkautasítás: ${a.orderNumber}`,
      permission: "terminal.open_instructions",
      run: async (w) => {
        const r = await terminalApi.openInstruction(terminalUiId, w.ticket, a.workOrderId);
        setViewer({ instruction: r.instruction, orderNumber: a.orderNumber, tab: r.instruction.content.trim() ? "text" : "pdf" });
        return r.workerExpiresAt;
      },
    });
  }

  function activeChecks(m: TerminalMachine) {
    return m.current.flatMap((a) => (m.orders[a.workOrderId]?.quality?.checks ?? []).map((c) => ({ c, a })));
  }

  function measure(m: TerminalMachine) {
    const checks = activeChecks(m).sort((x, y) => rank(x.c) - rank(y.c));
    if (checks.length === 1) return setFlow({ checkId: checks[0]!.c.id, orderNumber: checks[0]!.a.orderNumber, purpose: { kind: "check" } });
    if (checks.length > 1) return setSheet({ kind: "measure", machineId: m.id });
    const a = runningOrder(m);
    if (!a) return;
    act({
      title: `Szúrópróba most: ${a.orderNumber}`,
      permission: "quality.measure",
      run: async (w) => {
        const r = await terminalApi.requestSpotCheck(terminalUiId, w.ticket, a.workOrderId);
        setFlow({ checkId: r.checkId, orderNumber: a.orderNumber, purpose: { kind: "check" } });
        return r.workerExpiresAt;
      },
    });
  }

  function actionsFor(m: TerminalMachine): MachineActions {
    return {
      primary: () => {
        const running = m.current.filter((a) => a.workOrderStatus === "in_progress");
        if (running.length === 1) return completeOrder(running[0]!, m.id);
        if (running.length > 1) return setSheet({ kind: "complete", machineId: m.id });
        const waiting = waitingOrders(m);
        if (waiting.length === 1) return startOrder(waiting[0]!);
        if (waiting.length > 1) setSheet({ kind: "start", machineId: m.id });
      },
      pause: () => {
        const running = m.current.filter((a) => a.workOrderStatus === "in_progress");
        if (running.length >= 1) completeOrder(running[0]!, m.id, "pause");
      },
      fault: () => setSheet({ kind: "fault", machineId: m.id }),
      status: () => setSheet({ kind: "status", machineId: m.id }),
      measure: () => measure(m),
      instruction: () => openInstruction(m),
      scrap: () => setSheet({ kind: "scrap", machineId: m.id }),
      history: () => setSheet({ kind: "history", machineId: m.id }),
      attention: (item) => item.checkId && setFlow({ checkId: item.checkId, orderNumber: item.orderNumber ?? "", purpose: { kind: "check" } }),
    };
  }

  if (!paired) {
    return (
      <div className="tx" data-theme={theme}>
        <div className="tx-notice">
          <h1>Ez a képernyő nincs párosítva</h1>
          <p>
            A terminál használatához egy adminisztrátornak párosítania kell ezt az eszközt: a dashboardon Admin → Terminals → <strong>Pair device</strong>, majd
            a megjelenő linket (QR-kódot) ezen az eszközön kell megnyitni. Egyszer kell megtenni; újraindítás után is megmarad.
          </p>
        </div>
      </div>
    );
  }

  const machines = state?.machines ?? [];
  const multi = machines.length > 1;
  const selected = multi ? (machines.find((m) => m.id === selectedId) ?? null) : (machines[0] ?? null);
  const secondsLeft = worker ? Math.max(0, Math.ceil((worker.expiresAt - now) / 1000)) : 0;
  const shiftSource = selected ?? machines.find((m) => m.shift) ?? null;

  return (
    <div className="tx" data-theme={theme}>
      <header className="tx-head">
        {multi && selected && (
          <button type="button" className="tx-back" onClick={() => setSelectedId(null)}>
            <IconChevronLeft size={24} /> Összes gép
          </button>
        )}
        <div className="tx-head-title">
          <span className="tx-head-name">{selected ? selected.name : (state?.terminal.name ?? "Terminál")}</span>
          <span className="tx-muted">{selected ? (state?.terminal.name ?? "") : multi ? `${machines.length} gép · koppints egy gépre a részletekhez` : ""}</span>
        </div>
        {multi && selected && machines.length <= 4 && (
          <div className="tx-switch" role="group" aria-label="Gépváltás">
            {machines
              .filter((m) => m.id !== selected.id)
              .map((m) => (
                <button key={m.id} type="button" className="tx-switch-btn" onClick={() => setSelectedId(m.id)}>
                  <span className="tx-dot" data-tone={statusView(m).tone} />
                  {m.name}
                </button>
              ))}
          </div>
        )}
        <div className="tx-spacer" />
        {shiftSource?.shift && (
          <div className="tx-head-shift">
            <strong>{shiftSource.shift.shiftName}</strong>
            <span className="tx-muted">{shiftSource.shift.startTime ? `${shortTime(shiftSource.shift.startTime)}–${shortTime(shiftSource.shift.endTime)}` : "műszak"}</span>
          </div>
        )}
        <div className="tx-conn" data-ok={loadError ? "false" : "true"}>
          <span className="tx-conn-dot" />
          {loadError ? "Nincs kapcsolat" : "Online"}
        </div>
        <span className="tx-clock">{hhmm(now)}</span>
        <button type="button" className="tx-icon-btn" aria-label={theme === "dark" ? "Világos téma" : "Sötét téma"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          {theme === "dark" ? <IconSun size={22} /> : <IconMoon size={22} />}
        </button>
        {worker ? (
          <div className="tx-worker">
            <span className="tx-avatar">{initials(worker.name)}</span>
            <span className="tx-worker-text">
              <strong>{worker.name}</strong>
              <span className="tx-muted">
                {worker.roleName} · még {secondsLeft} mp
              </span>
            </span>
            <button type="button" className="tx-worker-out" onClick={signOut}>
              Kilépés
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="tx-login"
            onClick={() => {
              setPinError(null);
              setPending({ title: "Belépés", permission: "", run: async () => undefined });
            }}
          >
            <IconLock size={22} /> Belépés kóddal
          </button>
        )}
      </header>

      {loadError && <div className="tx-offline">Nincs kapcsolat a szerverrel — a képernyő a legutóbbi állapotot mutatja. ({loadError})</div>}

      {!state && !loadError && <p className="tx-loading">Betöltés…</p>}
      {state && machines.length === 0 && <p className="tx-loading">Ehhez a terminálhoz nincs gép rendelve (Admin → Terminals).</p>}
      {state && selected && <TerminalMachineView key={selected.id} m={selected} busy={busy} now={now} actions={actionsFor(selected)} />}
      {state && multi && !selected && <TerminalOverview machines={machines} now={now} onOpen={(id) => setSelectedId(id)} />}

      {message && (
        <div className="tx-toast" data-kind={message.kind} role="status">
          {message.kind === "ok" ? "✓ " : ""}
          {message.text}
        </div>
      )}

      {sheet?.kind === "scrap" && state && (() => {
        const m = state.machines.find((x) => x.id === sheet.machineId);
        return m ? (
          <TerminalScrapSheet
            m={m}
            busy={busy}
            onCancel={() => setSheet(null)}
            onSubmit={(reason, quantity) => {
              setSheet(null);
              const run = runningOrder(m);
              act({
                title: `Selejt: ${quantity} db — ${reason.name} (${m.name})`,
                permission: "terminal.report_scrap",
                run: async (w) => {
                  const r = await terminalApi.reportScrap(terminalUiId, w.ticket, m.id, { reasonId: reason.id, quantity, workOrderId: run?.workOrderId });
                  flash("ok", `Selejt lejelentve: ${quantity} db — ${reason.name} (${w.name})`);
                  return r.workerExpiresAt;
                },
              });
            }}
          />
        ) : null;
      })()}

      {sheet?.kind === "report" && state && (() => {
        const m = state.machines.find((x) => x.id === sheet.machineId);
        const a = m?.current.find((x) => x.workOrderId === sheet.workOrderId);
        return m && a ? (
          <TerminalReportSheet
            terminalId={terminalUiId}
            machineName={m.name}
            order={a}
            intent={sheet.intent}
            busy={busy}
            onCancel={() => setSheet(null)}
            onSubmit={(report, outcome) => {
              setSheet(null);
              sendReport(a, report, outcome);
            }}
          />
        ) : null;
      })()}

      {sheet && sheet.kind !== "scrap" && sheet.kind !== "report" && state && (
        <MachineSheet sheet={sheet} state={state} close={() => setSheet(null)} act={act} terminalId={terminalUiId} flash={flash} start={startOrder} complete={completeOrder} openCheck={(checkId, orderNumber) => setFlow({ checkId, orderNumber, purpose: { kind: "check" } })} />
      )}

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

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toLocaleUpperCase("hu-HU"))
    .join("");
}

function rank(c: { status: string; gating: boolean; overdue: boolean }): number {
  return c.status === "failed" ? 0 : c.gating ? 1 : c.overdue ? 2 : 3;
}

/** The lists of one machine (fault, status, which order to start / complete, which check to measure, history). */
function MachineSheet({
  sheet,
  state,
  close,
  act,
  terminalId,
  flash,
  start,
  complete,
  openCheck,
}: {
  sheet: Sheet;
  state: TerminalState;
  close: () => void;
  act: (action: Action) => void;
  terminalId: string;
  flash: (kind: "ok" | "error", text: string) => void;
  start: (a: TerminalAssignment) => void;
  complete: (a: TerminalAssignment, machineId: string) => void;
  openCheck: (checkId: string, orderNumber: string) => void;
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

  if (sheet.kind === "start" || sheet.kind === "complete") {
    const list = sheet.kind === "start" ? waitingOrders(m) : m.current.filter((a) => a.workOrderStatus === "in_progress");
    return (
      <TerminalChoiceSheet
        title={`${sheet.kind === "start" ? "Melyik rendelést indítod vagy folytatod?" : "Melyik rendelést jelented le?"} — ${m.name}`}
        subtitle={sheet.kind === "start" && list.some(isPaused) ? "A sárga keretesek szüneteltetett megbízások: koppintásra ott folytatódnak, ahol abbahagyták." : undefined}
        emptyText="Nincs ilyen rendelés."
        choices={list.map((a) => ({ key: a.workOrderId, label: a.partName, sub: waitingText(m, a), tone: isPaused(a) ? ("warn" as const) : undefined }))}
        onCancel={close}
        onChoose={(id) => {
          const a = list.find((x) => x.workOrderId === id)!;
          close();
          if (sheet.kind === "start") start(a);
          else complete(a, m.id);
        }}
      />
    );
  }

  if (sheet.kind === "measure") {
    const checks = m.current.flatMap((a) => (m.orders[a.workOrderId]?.quality?.checks ?? []).map((c) => ({ c, a }))).sort((x, y) => rank(x.c) - rank(y.c));
    return (
      <TerminalChoiceSheet
        title={`Mérés — ${m.name}`}
        subtitle="Melyik ellenőrzést végzed?"
        emptyText="Nincs nyitott ellenőrzés."
        choices={checks.map(({ c, a }) => ({
          key: c.id,
          label: KIND_LABEL_HU[c.kind],
          sub: `${a.orderNumber} · ${c.passedCount} / ${c.total} kész${c.status === "failed" ? " · tűrésen kívül" : c.overdue ? " · késésben" : ""}`,
          tone: c.status === "failed" ? ("alarm" as const) : undefined,
        }))}
        onCancel={close}
        onChoose={(id) => {
          const found = checks.find((x) => x.c.id === id)!;
          close();
          openCheck(found.c.id, found.a.orderNumber);
        }}
      />
    );
  }

  if (sheet.kind === "history") {
    return (
      <TerminalChoiceSheet
        title={`Korábbi rendelések — ${m.name}`}
        emptyText="Nincs korábbi rendelés."
        choices={m.history.map((a) => ({ key: a.id, label: a.partName, sub: `${a.orderNumber} · ${int(a.quantity)} db · ${a.workOrderStatus === "completed" ? "kész" : "törölve"} · ${plannedText(a.plannedEnd)}` }))}
        onCancel={close}
        onChoose={close}
      />
    );
  }

  const manual = m.status?.manual;
  return (
    <TerminalChoiceSheet
      title={`Státusz — ${m.name}`}
      subtitle={
        manual
          ? "Az új állapot mostantól számít (az előző eddig tartott). A kézi állapot addig marad, amíg le nem zárod; ha nem tiltja a gyártást, a gép első gyártási jelére is véget ér."
          : m.status && m.status.code !== "running" && m.status.code !== "off_shift"
            ? `A kiválasztott állapot a megállástól (${hhmm(m.status.since)}) számít. Ha nem tiltja a gyártást, a gép első gyártási jelére véget ér; ha tiltja, csak lezárással.`
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
