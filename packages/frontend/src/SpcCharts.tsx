import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * SPC-diagramok egyszerű SVG-ben (nincs diagramkönyvtár a projektben, és ez
 * a három forma kevés kódból megvan): vezérlőkártya (I és MR) és hisztogram.
 * Egy adatsor (a mérés) — jelmagyarázat-doboz nélkül, a cím mondja meg, mi
 * látszik; a referenciavonalak a jobb szélen felirattal. A tűrésen kívüli és a
 * szabályt sértő pontok alakkal is különböznek, nem csak színnel.
 */

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export type RefTone = "spec" | "control" | "center" | "nominal";
export interface RefLine {
  y: number;
  label: string;
  tone: RefTone;
}
export interface ChartPoint {
  y: number | null;
  /** spec: out of tolerance (square, alarm); signal: a control rule broken (diamond, warning). */
  flag: "spec" | "signal" | null;
  tooltip: ReactNode;
}

const PAD = { top: 12, right: 92, bottom: 26, left: 56 };
const TONE_CLASS: Record<RefTone, string> = { spec: "spc-ref-spec", control: "spc-ref-control", center: "spc-ref-center", nominal: "spc-ref-nominal" };

function niceTicks(min: number, max: number, count = 5): number[] {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => span / s <= count) ?? pow * 10;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

const fmtTick = (v: number) => String(Number(v.toPrecision(6)));

/** Spread label positions so two reference lines close together do not overlap. */
function placeLabels(ys: number[], min = 13): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const placed = order.map((o) => o.y);
  for (let k = 1; k < placed.length; k++) if (placed[k]! - placed[k - 1]! < min) placed[k] = placed[k - 1]! + min;
  const out = new Array<number>(ys.length);
  order.forEach((o, k) => (out[o.i] = placed[k]!));
  return out;
}

export function ControlChart({
  points,
  refs,
  xLabels,
  height = 260,
  ariaLabel,
  showMarkers = true,
}: {
  points: ChartPoint[];
  refs: RefLine[];
  /** Label under the x axis for some indexes. */
  xLabels: (i: number) => string;
  height?: number;
  ariaLabel: string;
  showMarkers?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const values = points.map((p) => p.y).filter((v): v is number => v !== null);
  const all = [...values, ...refs.map((r) => r.y)];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.08;
  const yMin = lo - pad;
  const yMax = hi + pad;
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * plotH;
  const ticks = useMemo(() => niceTicks(yMin, yMax), [yMin, yMax]);
  const xTickIdx = useMemo(() => {
    const n = points.length;
    const k = Math.min(n, Math.max(2, Math.floor(plotW / 110)));
    return [...new Set(Array.from({ length: k }, (_, j) => Math.round((j * (n - 1)) / Math.max(1, k - 1))))];
  }, [points.length, plotW]);

  let path = "";
  points.forEach((p, i) => {
    if (p.y === null) return;
    path += `${path === "" || points[i - 1]?.y === null ? "M" : "L"}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`;
  });
  const labelYs = placeLabels(refs.map((r) => y(r.y)));

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - box.left;
    const i = points.length <= 1 ? 0 : Math.round((px / box.width) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  }

  const hp = hover !== null ? points[hover] : null;
  return (
    <div ref={ref} className="spc-chart" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="spc-grid" x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} />
              <text className="spc-axis" x={PAD.left - 6} y={y(t)} textAnchor="end" dominantBaseline="middle">
                {fmtTick(t)}
              </text>
            </g>
          ))}
          {xTickIdx.map((i) => (
            <text key={i} className="spc-axis" x={x(i)} y={height - 8} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>
              {xLabels(i)}
            </text>
          ))}
          {refs.map((r, k) => (
            <g key={`${r.label}-${k}`} className={TONE_CLASS[r.tone]}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(r.y)} y2={y(r.y)} />
              <text x={PAD.left + plotW + 6} y={labelYs[k]} dominantBaseline="middle">
                {r.label}
              </text>
            </g>
          ))}
          <path className="spc-line" d={path} />
          {points.map((p, i) => {
            if (p.y === null) return null;
            const cx = x(i);
            const cy = y(p.y);
            if (p.flag === "spec") return <rect key={i} className="spc-mark-spec" x={cx - 5} y={cy - 5} width={10} height={10} rx={1.5} />;
            if (p.flag === "signal") return <path key={i} className="spc-mark-signal" d={`M${cx},${cy - 6}L${cx + 6},${cy}L${cx},${cy + 6}L${cx - 6},${cy}Z`} />;
            return showMarkers || hover === i ? <circle key={i} className="spc-mark" cx={cx} cy={cy} r={4} /> : null;
          })}
          {hp && hp.y !== null && (
            <>
              <line className="spc-cross" x1={x(hover!)} x2={x(hover!)} y1={PAD.top} y2={PAD.top + plotH} />
              <circle className="spc-mark spc-mark-hover" cx={x(hover!)} cy={y(hp.y)} r={5} />
            </>
          )}
          <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {hp && hover !== null && (
        <div className="spc-tip" style={{ left: Math.min(x(hover) + 12, Math.max(0, width - 240)), top: 8 }}>
          {hp.tooltip}
        </div>
      )}
    </div>
  );
}

export function Histogram({
  values,
  refs,
  height = 220,
  ariaLabel,
  unit,
}: {
  values: number[];
  refs: RefLine[];
  height?: number;
  ariaLabel: string;
  unit: string | null;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { top: 10, right: 16, bottom: 40, left: 36 };
  const all = [...values, ...refs.map((r) => r.y)];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo || 1;
  const binCount = Math.min(20, Math.max(5, Math.ceil(Math.sqrt(values.length))));
  const bw = span / binCount;
  const bins = Array.from({ length: binCount }, (_, k) => ({ from: lo + k * bw, to: lo + (k + 1) * bw, n: 0 }));
  for (const v of values) bins[Math.min(binCount - 1, Math.floor((v - lo) / bw))]!.n++;
  const maxN = Math.max(1, ...bins.map((b) => b.n));
  const plotW = Math.max(10, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const x = (v: number) => pad.left + ((v - lo) / span) * plotW;
  const slot = plotW / binCount;
  const barW = Math.min(24, Math.max(2, slot - 2));
  const yTicks = niceTicks(0, maxN, 4).filter((t) => Number.isInteger(t));
  const h = hover !== null ? bins[hover] : null;
  return (
    <div ref={ref} className="spc-chart" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          {yTicks.map((t) => (
            <g key={t}>
              <line className="spc-grid" x1={pad.left} x2={pad.left + plotW} y1={pad.top + plotH - (t / maxN) * plotH} y2={pad.top + plotH - (t / maxN) * plotH} />
              <text className="spc-axis" x={pad.left - 6} y={pad.top + plotH - (t / maxN) * plotH} textAnchor="end" dominantBaseline="middle">
                {t}
              </text>
            </g>
          ))}
          {bins.map((b, k) => {
            const bh = (b.n / maxN) * plotH;
            const cx = pad.left + slot * (k + 0.5);
            return (
              <g key={k} onPointerEnter={() => setHover(k)} onPointerLeave={() => setHover(null)}>
                <rect x={pad.left + slot * k} y={pad.top} width={slot} height={plotH} fill="transparent" />
                {b.n > 0 && <path className={hover === k ? "spc-bar spc-bar-hover" : "spc-bar"} d={roundedTop(cx - barW / 2, pad.top + plotH - bh, barW, bh)} />}
              </g>
            );
          })}
          {refs.map((r, k) => (
            <g key={k} className={TONE_CLASS[r.tone]}>
              <line x1={x(r.y)} x2={x(r.y)} y1={pad.top} y2={pad.top + plotH} />
              <text x={x(r.y)} y={height - 22 + (k % 2) * 13} textAnchor="middle">
                {r.label}
              </text>
            </g>
          ))}
        </svg>
      )}
      {h && (
        <div className="spc-tip" style={{ left: Math.min(pad.left + slot * hover! + slot, Math.max(0, width - 200)), top: 8 }}>
          <strong>{h.n}</strong> value{h.n === 1 ? "" : "s"}
          <span className="ui-sub">
            {fmtTick(h.from)} – {fmtTick(h.to)}
            {unit ? ` ${unit}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

/** A bar with 4px rounded top corners, square at the baseline. */
function roundedTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
