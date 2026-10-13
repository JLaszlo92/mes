/**
 * A terminál felületének tiszta (megjelenítés nélküli) részei: állapot →
 * felirat és tónus, a teendők listája, a gépek sorrendje az áttekintésben,
 * magyar szám- és időformázás.
 *
 * Színelv (ISA-101): a felület szürke, színt csak a gép állapota és a
 * rendellenesség kap — zöld: gyárt, piros: áll (leállásnak számít),
 * kékesszürke: tervezett állás, szürke: tétlen / nincs adat; sárga a
 * figyelmet kérő teendőké.
 */
import type { CheckKind, QualityCheck } from "./quality.js";
import type { TerminalAssignment, TerminalMachine } from "./terminal-api.js";

export type Tone = "run" | "down" | "planned" | "idle";

const BUILT_IN: Record<string, string> = { running: "Gyártás", down: "Leállás", off_shift: "Műszakon kívül" };

export interface StatusView {
  label: string;
  tone: Tone;
  since: string | null;
  manual: { setBy: string | null; blocksProduction: boolean } | null;
}

export function statusView(m: TerminalMachine): StatusView {
  if (!m.status) return { label: "Nincs adat", tone: "idle", since: null, manual: null };
  const code = m.status.code;
  const option = m.statusOptions.find((o) => o.code === code);
  const label = option?.label ?? BUILT_IN[code] ?? code;
  const tone: Tone =
    code === "running" ? "run" : code === "down" ? "down" : code === "off_shift" ? "idle" : option?.oeeCategory === "excluded" ? "planned" : "down";
  const manual = m.status.manual ? { setBy: m.status.manual.setBy, blocksProduction: m.status.manual.blocksProduction } : null;
  // A machine with no running order that is not producing is idle, not "down" in the shop's eyes.
  const idleNoOrder = tone === "down" && !manual && runningOrder(m) === undefined;
  return { label: idleNoOrder ? "Nincs rendelés" : label, tone: idleNoOrder ? "idle" : tone, since: m.status.since, manual };
}

/** The order being produced (the first running one). */
export function runningOrder(m: TerminalMachine): TerminalAssignment | undefined {
  return m.current.find((a) => a.workOrderStatus === "in_progress");
}

/** Orders waiting on the machine, in planned order. */
export function waitingOrders(m: TerminalMachine): TerminalAssignment[] {
  return m.current.filter((a) => a.workOrderStatus !== "in_progress");
}

export type AttentionKind = "quality_failed" | "first_piece" | "spot_overdue" | "check_due" | "fault_open";
export interface Attention {
  kind: AttentionKind;
  /** alarm: stops production or the count; warn: needs someone soon. */
  severity: "alarm" | "warn";
  title: string;
  detail: string;
  /** The quality check the button opens, if any. */
  checkId?: string;
  orderNumber?: string;
}

const KIND_HU: Record<CheckKind, string> = { first_piece: "Első darab", last_piece: "Utolsó darab", spot: "Szúrópróba" };

/** Everything someone should act on at this machine, the most urgent first. */
export function attentionItems(m: TerminalMachine, now = Date.now()): Attention[] {
  const out: Attention[] = [];
  for (const a of m.current) {
    const q = m.orders[a.workOrderId]?.quality;
    if (!q) continue;
    const checks = [...q.checks].sort((x, y) => rank(x) - rank(y));
    for (const c of checks) {
      if (c.status === "failed") {
        out.push({
          kind: "quality_failed",
          severity: "alarm",
          title: "Tűrésen kívüli mérés — a darabszámlálás szünetel",
          detail: `${KIND_HU[c.kind]} · ${a.orderNumber} · ${c.passedCount} / ${c.total} megfelelt`,
          checkId: c.id,
          orderNumber: a.orderNumber,
        });
      } else if (c.kind === "first_piece" && c.gating) {
        out.push({
          kind: "first_piece",
          severity: "alarm",
          title: "Első darab mérés szükséges — addig a darabok nem számítanak",
          detail: `${a.orderNumber} · ${c.passedCount} / ${c.total} kész`,
          checkId: c.id,
          orderNumber: a.orderNumber,
        });
      } else if (c.overdue) {
        out.push({
          kind: "spot_overdue",
          severity: "warn",
          title: `${KIND_HU[c.kind]} késésben`,
          detail: `${minutesAgo(c.createdAt, now)} perce esedékes · ${a.orderNumber}`,
          checkId: c.id,
          orderNumber: a.orderNumber,
        });
      } else {
        out.push({
          kind: "check_due",
          severity: "warn",
          title: `${KIND_HU[c.kind]} esedékes`,
          detail: `${a.orderNumber} · ${c.passedCount} / ${c.total} kész`,
          checkId: c.id,
          orderNumber: a.orderNumber,
        });
      }
    }
  }
  for (const r of m.recentReports) {
    if (r.status !== "pending") continue;
    if (now - new Date(r.reportedAt).getTime() > 24 * 3600_000) continue;
    out.push({
      kind: "fault_open",
      severity: "warn",
      title: `Nyitott hibajelentés: ${r.faultCode} ${r.faultName}`,
      detail: `${hhmm(r.reportedAt)}${r.reportedBy ? ` · ${r.reportedBy}` : ""} · a karbantartás még nem vette át`,
    });
  }
  const order: Record<AttentionKind, number> = { quality_failed: 0, first_piece: 1, spot_overdue: 2, check_due: 3, fault_open: 4 };
  return out.sort((a, b) => order[a.kind] - order[b.kind]);
}

function rank(c: QualityCheck): number {
  return c.status === "failed" ? 0 : c.gating ? 1 : c.overdue ? 2 : 3;
}

/** Overview order: needs attention first (stopped, then warnings), then producing, then idle. */
export function machinePriority(m: TerminalMachine): number {
  const s = statusView(m);
  const items = attentionItems(m);
  if (items.some((i) => i.severity === "alarm")) return 0;
  if (s.tone === "down") return 1;
  if (items.length > 0) return 2;
  if (s.tone === "run") return 3;
  if (s.tone === "planned") return 4;
  return 5;
}

export function sortForOverview(machines: TerminalMachine[]): TerminalMachine[] {
  return machines
    .map((m, i) => ({ m, i, p: machinePriority(m) }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map((x) => x.m);
}

// ---------- formatting (Hungarian) ----------

export function hhmm(iso: string | number | Date): string {
  return new Date(iso).toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "14:00" from "14:00:00". */
export function shortTime(t: string | null | undefined): string {
  return t ? t.slice(0, 5) : "";
}

export function minutesAgo(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

/** "6 perce", "2 óra 14 perce", "1 napja". */
export function sinceText(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const min = minutesAgo(iso, now);
  if (min < 1) return "most";
  if (min < 60) return `${min} perce`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} óra ${min % 60} perce`;
  return `${Math.floor(h / 24)} napja`;
}

/** Compact: "6 p", "2 ó 14 p". */
export function sinceShort(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const min = minutesAgo(iso, now);
  if (min < 60) return `${min} p`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} ó ${min % 60} p` : `${Math.floor(h / 24)} nap`;
}

const intFmt = new Intl.NumberFormat("hu-HU", { maximumFractionDigits: 0 });
const dec1 = new Intl.NumberFormat("hu-HU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function int(n: number): string {
  return intFmt.format(n);
}

export function seconds1(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `${dec1.format(n)} s`;
}

export function percent(r: number | null | undefined): string {
  return r === null || r === undefined ? "—" : `${Math.round(r * 100)} %`;
}

export function plannedText(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 86400_000).toDateString() === d.toDateString();
  const t = hhmm(d);
  if (sameDay) return t;
  if (tomorrow) return `holnap ${t}`;
  return `${d.toLocaleDateString("hu-HU", { month: "short", day: "numeric" })} ${t}`;
}

/** When the order will be done at the current pace (or the planned cycle), or null. */
export function expectedEnd(remaining: number, cycleSeconds: number | null, now = Date.now()): Date | null {
  if (!cycleSeconds || cycleSeconds <= 0 || remaining <= 0) return null;
  return new Date(now + remaining * cycleSeconds * 1000);
}
