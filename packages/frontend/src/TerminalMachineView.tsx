import type { ReactNode } from "react";
import type { TerminalMachine } from "./terminal-api.js";
import { KIND_LABEL_HU } from "./quality.js";
import {
  attentionItems,
  expectedEnd,
  hhmm,
  int,
  percent,
  plannedText,
  runningOrder,
  seconds1,
  shortTime,
  sinceText,
  statusView,
  waitingOrders,
  waitingText,
  isPaused,
  type Attention,
} from "./terminal-model.js";
import { IconCheck, IconClock, IconDoc, IconFault, IconHistory, IconPause, IconPlay, IconPulse, IconRuler, IconStop, IconTrash, IconX, StateIcon } from "./TerminalIcons.js";

export interface MachineActions {
  primary: () => void;
  /** Report the running order off the machine (pause), with the final count dialog. */
  pause: () => void;
  fault: () => void;
  status: () => void;
  measure: () => void;
  instruction: () => void;
  scrap: () => void;
  history: () => void;
  attention: (item: Attention) => void;
}

/**
 * Egy gép képernyője (látványterv 1–3.): állapotsáv, az aktuális rendelés
 * nagy számlálóval, teendők, műszak-OEE és minőség, a következő rendelések,
 * jobbra a fix műveleti gombsor. A műveletek a gépre szólnak, ezért csak itt
 * vannak — az áttekintésben nincsenek.
 */
export default function TerminalMachineView({ m, busy, now, actions }: { m: TerminalMachine; busy: boolean; now: number; actions: MachineActions }) {
  const s = statusView(m);
  const run = runningOrder(m);
  const order = run ? m.orders[run.workOrderId] : undefined;
  const progress = order?.progress ?? null;
  const quality = order?.quality ?? null;
  const items = attentionItems(m, now);
  const waiting = waitingOrders(m);
  const cycle = m.rate.cycleSeconds;
  const planned = order?.plannedCycleSeconds ?? m.rate.idealCycleSeconds;
  const paused = quality?.hold != null || s.manual?.blocksProduction === true;
  const end = progress && !progress.targetReached ? expectedEnd(progress.remaining, s.tone === "run" ? (cycle ?? planned) : planned, now) : null;
  const activeChecks = m.current.reduce((n, a) => n + (m.orders[a.workOrderId]?.quality?.checks.length ?? 0), 0);
  const measureFirst = items.some((i) => i.severity === "alarm" && i.checkId);
  const total = progress ? progress.goodCount + progress.scrapCount : 0;

  const measureButton = (
    <RailButton key="measure" icon={<IconRuler />} label="Mérés" sub={activeChecks === 0 ? (quality?.planVersion != null ? "szúrópróba most" : "nincs nyitott") : undefined} badge={activeChecks || undefined} primary={measureFirst} disabled={busy || (activeChecks === 0 && quality?.planVersion == null)} onClick={actions.measure} />
  );
  const primaryButton = run ? (
    <RailButton key="primary" icon={<IconStop />} label="Befejezés" sub="lejelentés, lezárás" primary={!measureFirst} disabled={busy} onClick={actions.primary} />
  ) : (
    <RailButton key="primary" icon={<IconPlay />} label={waiting[0] && isPaused(waiting[0]) ? "Folytatás" : "Indítás"} sub={waiting.length > 1 ? `${waiting.length} rendelés közül` : waiting[0] ? waiting[0].orderNumber : "nincs rendelés"} primary={!measureFirst && waiting.length > 0} disabled={busy || waiting.length === 0} onClick={actions.primary} />
  );

  return (
    <div className="tx-machine">
      <section className="tx-band" data-tone={s.tone} aria-label="Gépállapot">
        <StateIcon tone={s.tone} />
        <div className="tx-band-main">
          <span className="tx-band-state">{s.label.toLocaleUpperCase("hu-HU")}</span>
          <span className="tx-band-sub">
            {sinceText(s.since, now)}
            {s.manual ? ` · kézzel állította: ${s.manual.setBy ?? "?"}` : s.since ? " · a gép jele szerint" : ""}
            {s.manual?.blocksProduction ? " · gyártás tiltva" : ""}
          </span>
        </div>
        <div className="tx-spacer" />
        {s.tone === "run" ? (
          <div className="tx-band-figures">
            <Figure label="Ciklusidő" value={seconds1(cycle)} sub={planned ? `terv ${seconds1(planned)}` : undefined} />
            <Figure label="Darab / óra" value={int(m.rate.partsLastHour)} sub={planned ? `terv ${int(3600 / planned)}` : "utolsó 60 perc"} />
          </div>
        ) : (
          <div className="tx-band-figures">
            <Figure label="Leállás ebben a műszakban" value={`${int(Math.round((m.shift?.downSeconds ?? 0) / 60))} perc`} sub={m.shift?.downCount ? `${m.shift.downCount} alkalom` : undefined} />
          </div>
        )}
      </section>

      <div className="tx-body">
        <main className="tx-main">
          {items.length > 0 && (
            <section className="tx-attention" aria-label="Teendők">
              {items.slice(0, 3).map((item, i) => (
                <div key={i} className="tx-alert" data-severity={item.severity}>
                  {item.severity === "alarm" ? <IconX size={30} /> : item.kind === "fault_open" ? <IconFault size={30} /> : <IconClock size={30} />}
                  <div className="tx-alert-text">
                    <span className="tx-alert-title">{item.title}</span>
                    <span className="tx-alert-detail">{item.detail}</span>
                  </div>
                  {item.checkId && (
                    <button type="button" className="tx-alert-btn" disabled={busy} onClick={() => actions.attention(item)}>
                      {item.kind === "quality_failed" ? "Újramérés" : "Mérés"}
                    </button>
                  )}
                </div>
              ))}
              {items.length > 3 && <span className="tx-muted">és még {items.length - 3} teendő</span>}
            </section>
          )}

          {run && progress ? (
            <section className="tx-card tx-job" aria-label="Aktuális rendelés">
              <div className="tx-job-head">
                <span className="tx-job-part">{run.partName}</span>
                <span className="tx-muted tx-job-wo">{run.orderNumber}</span>
                <div className="tx-spacer" />
                {paused ? (
                  <span className="tx-pill" data-tone="warn">
                    <IconPause size={16} /> Számlálás szünetel{quality?.hold ? ` ${hhmm(quality.hold.since)} óta` : ""}
                  </span>
                ) : (
                  <span className="tx-muted tx-job-docs">
                    {[order?.instruction && `Munkautasítás v${order.instruction.version}`, quality?.planVersion != null && `Minőségterv v${quality.planVersion}`].filter(Boolean).join(" · ")}
                  </span>
                )}
                <button type="button" className="tx-pause-btn" disabled={busy} onClick={actions.pause}>
                  <IconPause size={22} /> Szüneteltetés
                </button>
              </div>
              <div className="tx-counter" data-paused={paused ? "true" : undefined}>
                <span className="tx-counter-value">{int(progress.goodCount)}</span>
                <span className="tx-counter-target">/ {int(progress.quantity)} db</span>
                <div className="tx-spacer" />
                <span className="tx-counter-pct">{progress.targetReached ? "Kész" : `${Math.min(100, Math.floor((progress.goodCount / Math.max(1, progress.quantity)) * 100))} %`}</span>
              </div>
              <div className="tx-progress" data-paused={paused ? "true" : undefined}>
                <div style={{ width: `${Math.min(100, (progress.goodCount / Math.max(1, progress.quantity)) * 100)}%` }} />
              </div>
              <div className="tx-kpis">
                <Kpi label="Selejt" value={int(progress.scrapCount)} sub={total > 0 ? `${((progress.scrapCount / total) * 100).toLocaleString("hu-HU", { maximumFractionDigits: 1 })} %` : undefined} />
                <Kpi label="Hátra" value={`${int(progress.remaining)} db`} />
                <Kpi label="Várható vége" value={progress.targetReached ? "elérve" : end ? hhmm(end) : "—"} />
                {items.length > 0 ? (
                  <Kpi label="Műszak OEE" value={percent(m.shift?.oee)} />
                ) : (
                  <Kpi label="Indította" value={progress.operator ? `${progress.operator}${progress.startedAt ? ` · ${hhmm(progress.startedAt)}` : ""}` : "—"} small />
                )}
              </div>
            </section>
          ) : (
            <section className="tx-card tx-job tx-empty" aria-label="Nincs futó rendelés">
              <span className="tx-job-part">Nincs futó rendelés</span>
              {waiting[0] ? (
                <>
                  <span className="tx-muted">{isPaused(waiting[0]) ? "Szüneteltetett megbízás — ezen a gépen folytatható:" : "Következő a sorban:"}</span>
                  <span className="tx-next-big">
                    {waiting[0].partName} <span className="tx-muted">· {waitingText(m, waiting[0])}</span>
                  </span>
                  {isPaused(waiting[0]) && m.paused[waiting[0].workOrderId]?.pausedAt && (
                    <span className="tx-muted">
                      Lejelentve {hhmm(m.paused[waiting[0].workOrderId]!.pausedAt!)}
                      {m.paused[waiting[0].workOrderId]!.pausedBy ? ` · ${m.paused[waiting[0].workOrderId]!.pausedBy}` : ""} · még {int(m.paused[waiting[0].workOrderId]!.remaining)} db hiányzik
                    </span>
                  )}
                  {!isPaused(waiting[0]) && waiting.some(isPaused) && (
                    <span className="tx-muted">
                      Szüneteltetve:{" "}
                      {waiting
                        .filter(isPaused)
                        .map((a) => `${a.partName} (${int(m.paused[a.workOrderId]?.goodCount ?? 0)} / ${int(m.paused[a.workOrderId]?.quantity ?? a.quantity)} db)`)
                        .join(", ")}
                    </span>
                  )}
                  <span className="tx-muted">
                    {waiting.length > 1 ? "Az Indítás gombbal választhatsz: új rendelés vagy a szüneteltetett folytatása." : `${isPaused(waiting[0]) ? "Folytatás" : "Indítás"} a jobb oldali gombbal.`}
                  </span>
                </>
              ) : (
                <span className="tx-muted">Erre a gépre nincs ütemezett rendelés.</span>
              )}
            </section>
          )}

          {items.length === 0 && (
            <div className="tx-row2">
              <section className="tx-card tx-oee" aria-label="Műszak OEE">
                <div className="tx-oee-big">
                  <span className="tx-muted">Műszak OEE</span>
                  <span className="tx-oee-value">{m.shift?.oee != null ? Math.round(m.shift.oee * 100) : "—"}<small>{m.shift?.oee != null ? "%" : ""}</small></span>
                  {m.shift && <span className="tx-muted tx-small">{m.shift.shiftName}{m.shift.startTime ? ` · ${shortTime(m.shift.startTime)}–${shortTime(m.shift.endTime)}` : ""}</span>}
                </div>
                <div className="tx-oee-bars">
                  <Bar label="Rendelkezésre állás" value={m.shift?.availability ?? null} />
                  <Bar label="Teljesítmény" value={m.shift?.performance ?? null} />
                  <Bar label="Minőség" value={m.shift?.quality ?? null} />
                </div>
              </section>
              <section className="tx-card tx-quality" aria-label="Minőség">
                <span className="tx-muted">Minőség</span>
                {quality?.lastClosed ? (
                  <QualityLine
                    ok={quality.lastClosed.status === "passed"}
                    title={`${KIND_LABEL_HU[quality.lastClosed.kind]} ${quality.lastClosed.status === "passed" ? "megfelelt" : quality.lastClosed.status === "released" ? "feloldva" : quality.lastClosed.status === "skipped" ? "kihagyva" : "nem készült el"}`}
                    detail={`${quality.lastClosed.closedAt ? hhmm(quality.lastClosed.closedAt) : ""}${quality.lastClosed.closedByName ? ` · ${quality.lastClosed.closedByName}` : ""} · ${quality.lastClosed.passedCount} / ${quality.lastClosed.total} mérés`}
                  />
                ) : (
                  <QualityLine ok={null} title={quality?.planVersion != null ? "Még nincs lezárt ellenőrzés" : "Nincs minőségterv"} detail={run ? run.partName : "nincs futó rendelés"} />
                )}
                {quality?.spot?.enabled && (
                  <QualityLine
                    ok={null}
                    title="Szúrópróba"
                    detail={[quality.spot.everyParts && `${int(quality.spot.everyParts)} darabonként`, quality.spot.maxMinutes && `legkésőbb ${quality.spot.maxMinutes} percenként`].filter(Boolean).join(", ")}
                  />
                )}
              </section>
            </div>
          )}

          <section className="tx-next" aria-label="Következő rendelések">
            <span className="tx-muted tx-next-label">Következő</span>
            {(run ? waiting : waiting.slice(1)).slice(0, 2).map((a) => (
              <div key={a.id} className="tx-next-item" data-paused={isPaused(a) ? "true" : undefined}>
                <strong>{a.partName}</strong>
                <span className="tx-muted">{waitingText(m, a)}</span>
              </div>
            ))}
            {(run ? waiting : waiting.slice(1)).length === 0 && <span className="tx-muted tx-next-none">nincs több ütemezett rendelés</span>}
            {m.history.length > 0 && (
              <button type="button" className="tx-ghost-btn" onClick={actions.history}>
                <IconHistory size={20} /> Korábbiak ({m.history.length})
              </button>
            )}
          </section>
        </main>

        <nav className="tx-rail" aria-label="Műveletek">
          {measureFirst ? [measureButton, primaryButton] : [primaryButton]}
          <RailButton icon={<IconFault color="var(--t-fault-icon)" />} label="Hiba jelentése" disabled={busy} onClick={actions.fault} />
          <RailButton icon={<IconPulse />} label="Státusz" sub={s.manual ? `kézi: ${s.label}` : undefined} disabled={busy} onClick={actions.status} />
          {!measureFirst && measureButton}
          <RailButton
            icon={<IconTrash />}
            label="Selejt"
            sub={m.scrapReasons.length === 0 ? "nincs selejtok" : m.scrapMode === "reclassify" && !run ? "nincs futó rendelés" : undefined}
            disabled={busy || m.scrapReasons.length === 0 || (m.scrapMode === "reclassify" && !run)}
            onClick={actions.scrap}
          />
          <RailButton icon={<IconDoc />} label="Munkautasítás" sub={order?.instruction ? `v${order.instruction.version}${order.instruction.hasPdf ? " · PDF" : ""}` : "nincs"} disabled={busy || !order?.instruction} onClick={actions.instruction} />
        </nav>
      </div>
    </div>
  );
}

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tx-figure">
      <span className="tx-figure-label">{label}</span>
      <span className="tx-figure-value">{value}</span>
      {sub && <span className="tx-figure-label">{sub}</span>}
    </div>
  );
}

function Kpi({ label, value, sub, small }: { label: string; value: string; sub?: string; small?: boolean }) {
  return (
    <div className="tx-kpi">
      <span className="tx-muted">{label}</span>
      <span className="tx-kpi-value" data-small={small ? "true" : undefined}>
        {value} {sub && <span className="tx-kpi-sub">{sub}</span>}
      </span>
    </div>
  );
}

function Bar({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="tx-bar">
      <div className="tx-bar-head">
        <span className="tx-muted">{label}</span>
        <strong>{percent(value)}</strong>
      </div>
      <div className="tx-bar-track">
        <div style={{ width: `${Math.round((value ?? 0) * 100)}%` }} />
      </div>
    </div>
  );
}

function QualityLine({ ok, title, detail }: { ok: boolean | null; title: string; detail: string }) {
  return (
    <div className="tx-qline">
      {ok === true ? <IconCheck size={26} color="var(--t-ok-icon)" /> : ok === false ? <IconX size={26} color="var(--t-warn-icon)" /> : <IconClock size={26} color="var(--t-muted)" />}
      <div className="tx-qline-text">
        <strong>{title}</strong>
        <span className="tx-muted">{detail}</span>
      </div>
    </div>
  );
}

function RailButton({
  icon,
  label,
  sub,
  badge,
  primary,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  sub?: string;
  badge?: number;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="tx-rail-btn" data-primary={primary ? "true" : undefined} disabled={disabled} onClick={onClick}>
      {icon}
      <span className="tx-rail-label">
        {label}
        {sub && <span className="tx-rail-sub">{sub}</span>}
      </span>
      {badge ? <span className="tx-badge">{badge}</span> : null}
    </button>
  );
}
