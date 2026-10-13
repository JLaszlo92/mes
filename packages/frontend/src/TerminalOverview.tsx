import { useState } from "react";
import type { TerminalMachine } from "./terminal-api.js";
import { attentionItems, int, percent, plannedText, runningOrder, sinceShort, sortForOverview, statusView, waitingOrders, type Tone } from "./terminal-model.js";
import { IconChevronRight, IconClock, IconFault, IconX } from "./TerminalIcons.js";

/**
 * Több gépes terminál áttekintése (látványterv 5–6.): 2–4 gépnél csempék,
 * 5 felett lista, a figyelmet kérő gépek elöl. Koppintásra a gép saját
 * képernyője nyílik; itt nincs művelet, hogy semmi ne menjen rossz géphez.
 */
export default function TerminalOverview({ machines, now, onOpen }: { machines: TerminalMachine[]; now: number; onOpen: (id: string) => void }) {
  return machines.length <= 4 ? <Tiles machines={machines} now={now} onOpen={onOpen} /> : <List machines={machines} now={now} onOpen={onOpen} />;
}

function Tiles({ machines, now, onOpen }: { machines: TerminalMachine[]; now: number; onOpen: (id: string) => void }) {
  const sorted = sortForOverview(machines);
  return (
    <div className="tx-tiles" data-count={machines.length}>
      {sorted.map((m) => {
        const s = statusView(m);
        const run = runningOrder(m);
        const progress = run ? m.orders[run.workOrderId]?.progress : null;
        const item = attentionItems(m, now)[0];
        const next = waitingOrders(m)[0];
        const paused = run ? m.orders[run.workOrderId]?.quality?.hold != null || s.manual?.blocksProduction === true : false;
        return (
          <button key={m.id} type="button" className="tx-tile" data-attention={item?.severity} onClick={() => onOpen(m.id)} aria-label={`${m.name} megnyitása`}>
            <div className="tx-tile-band" data-tone={s.tone}>
              <span className="tx-tile-name">{m.name}</span>
              <span className="tx-spacer" />
              <span className="tx-tile-state">{s.label.toLocaleUpperCase("hu-HU")}</span>
              <span className="tx-tile-since">{sinceShort(s.since, now)}</span>
            </div>
            <div className="tx-tile-body">
              {run && progress ? (
                <>
                  <div className="tx-tile-order">
                    <strong>{run.partName}</strong>
                    <span className="tx-muted">{run.orderNumber}</span>
                  </div>
                  <div className="tx-tile-counter" data-paused={paused ? "true" : undefined}>
                    <span className="tx-tile-count">{int(progress.goodCount)}</span>
                    <span className="tx-tile-target">/ {int(progress.quantity)} db</span>
                    <span className="tx-spacer" />
                    <span className="tx-muted">OEE {percent(m.shift?.oee)}</span>
                  </div>
                  <div className="tx-progress tx-progress-thin" data-paused={paused ? "true" : undefined}>
                    <div style={{ width: `${Math.min(100, (progress.goodCount / Math.max(1, progress.quantity)) * 100)}%` }} />
                  </div>
                </>
              ) : (
                <>
                  <span className="tx-muted">{next ? "Következő a sorban" : "Nincs ütemezett rendelés"}</span>
                  {next && (
                    <div className="tx-tile-order">
                      <strong>{next.partName}</strong>
                      <span className="tx-muted">
                        {next.orderNumber} · {int(next.quantity)} db · {plannedText(next.plannedStart)}
                      </span>
                    </div>
                  )}
                </>
              )}
              <div className="tx-tile-foot">
                {item ? (
                  <span className="tx-tile-alert" data-severity={item.severity}>
                    {item.severity === "alarm" ? <IconX size={20} /> : item.kind === "fault_open" ? <IconFault size={20} /> : <IconClock size={20} />}
                    {item.title}
                  </span>
                ) : (
                  <span className="tx-muted tx-tile-open">
                    <IconChevronRight size={20} /> {run ? "Részletek és műveletek" : next ? "Megnyitás az indításhoz" : "Megnyitás"}
                  </span>
                )}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

type Filter = "all" | "attention" | "down" | "run" | "idle";

function List({ machines, now, onOpen }: { machines: TerminalMachine[]; now: number; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const rows = sortForOverview(machines).map((m) => ({ m, s: statusView(m), items: attentionItems(m, now) }));
  const is = (tone: Tone) => (r: (typeof rows)[number]) => r.s.tone === tone;
  const counts = {
    all: rows.length,
    attention: rows.filter((r) => r.items.length > 0).length,
    down: rows.filter(is("down")).length,
    run: rows.filter(is("run")).length,
    idle: rows.filter((r) => r.s.tone === "idle" || r.s.tone === "planned").length,
  };
  const shown = rows.filter((r) =>
    filter === "all" ? true : filter === "attention" ? r.items.length > 0 : filter === "idle" ? r.s.tone === "idle" || r.s.tone === "planned" : r.s.tone === filter,
  );
  const oees = machines.map((m) => m.shift?.oee).filter((v): v is number => typeof v === "number");
  const chips: { key: Filter; label: string; tone?: string }[] = [
    { key: "all", label: "Mind" },
    { key: "attention", label: "Figyelmet kér", tone: "warn" },
    { key: "down", label: "Áll", tone: "down" },
    { key: "run", label: "Gyárt", tone: "run" },
    { key: "idle", label: "Tétlen", tone: "idle" },
  ];
  return (
    <div className="tx-list-wrap">
      <div className="tx-chips" role="group" aria-label="Szűrés állapot szerint">
        {chips.map((c) => (
          <button key={c.key} type="button" className="tx-chip" data-tone={c.tone} aria-pressed={filter === c.key} onClick={() => setFilter(c.key)}>
            {c.tone && <span className="tx-chip-dot" data-tone={c.tone} />}
            {c.label} · {counts[c.key]}
          </button>
        ))}
        <span className="tx-spacer" />
        {oees.length > 0 && (
          <span className="tx-muted">
            Átlagos OEE <strong className="tx-strong-num">{percent(oees.reduce((a, b) => a + b, 0) / oees.length)}</strong>
          </span>
        )}
      </div>
      <div className="tx-list-head" aria-hidden="true">
        <span />
        <span>Állapot</span>
        <span>Gép</span>
        <span>Rendelés</span>
        <span>Haladás</span>
        <span className="tx-right">OEE</span>
        <span>Teendő</span>
        <span />
      </div>
      <div className="tx-list">
        {shown.map(({ m, s, items }) => {
          const run = runningOrder(m);
          const progress = run ? m.orders[run.workOrderId]?.progress : null;
          const next = waitingOrders(m)[0];
          const item = items[0];
          return (
            <button key={m.id} type="button" className="tx-list-row" data-attention={item?.severity} onClick={() => onOpen(m.id)} aria-label={`${m.name} megnyitása`}>
              <span className="tx-list-bar" data-tone={s.tone} />
              <span className="tx-list-state">
                <strong data-tone={s.tone}>{s.label.toLocaleUpperCase("hu-HU")}</strong>
                <span className="tx-muted">
                  {sinceShort(s.since, now)}
                  {s.manual ? " · kézi" : ""}
                </span>
              </span>
              <span className="tx-list-name">{m.name}</span>
              <span className="tx-list-order">
                {run ? (
                  <>
                    <strong>{run.partName}</strong>
                    <span className="tx-muted">{run.orderNumber}</span>
                  </>
                ) : next ? (
                  <>
                    <span className="tx-muted">Következő: {next.partName}</span>
                    <span className="tx-faint">
                      {next.orderNumber} · {plannedText(next.plannedStart)}
                    </span>
                  </>
                ) : (
                  <span className="tx-faint">—</span>
                )}
              </span>
              <span className="tx-list-progress">
                {progress ? (
                  <>
                    <span>
                      <strong>{int(progress.goodCount)}</strong> / {int(progress.quantity)} db
                    </span>
                    <span className="tx-progress tx-progress-thin">
                      <span style={{ width: `${Math.min(100, (progress.goodCount / Math.max(1, progress.quantity)) * 100)}%` }} />
                    </span>
                  </>
                ) : (
                  <span className="tx-faint">—</span>
                )}
              </span>
              <span className="tx-right tx-list-oee">{percent(m.shift?.oee)}</span>
              <span className="tx-list-todo" data-severity={item?.severity}>
                {item ? (
                  <>
                    {item.severity === "alarm" ? <IconX size={18} /> : item.kind === "fault_open" ? <IconFault size={18} /> : <IconClock size={18} />}
                    <span>{item.title}</span>
                  </>
                ) : (
                  <span className="tx-faint">—</span>
                )}
              </span>
              <IconChevronRight size={22} color="var(--t-muted)" />
            </button>
          );
        })}
        {shown.length === 0 && <p className="tx-muted">Nincs ilyen gép.</p>}
      </div>
    </div>
  );
}
