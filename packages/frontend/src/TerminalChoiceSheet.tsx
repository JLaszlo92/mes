import { useEffect, useState, type ReactNode } from "react";
import { matches } from "./ui/lists.js";

/** From this many choices on, the sheet gets a search field (fault codes, waiting orders, scrap reasons). */
export const SEARCH_FROM = 12;

export interface Choice {
  key: string;
  label: string;
  sub?: string;
  /** A small colour mark (status colour). */
  color?: string | null;
  tone?: "alarm" | "warn" | "neutral";
}

/**
 * Teljes képernyős választólista a terminálon (hiba oka, gépállapot): nagy,
 * érintésre méretezett gombok. A választás után a terminál kéri a kódot.
 */
export default function TerminalChoiceSheet({
  title,
  subtitle,
  choices,
  footer,
  emptyText,
  onChoose,
  onCancel,
}: {
  title: string;
  subtitle?: string;
  choices: Choice[];
  footer?: ReactNode;
  emptyText: string;
  onChoose: (key: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const many = choices.length >= SEARCH_FROM;
  const shown = many && query ? choices.filter((c) => matches(`${c.label} ${c.sub ?? ""}`, query)) : choices;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="term-pin" role="dialog" aria-modal="true" aria-label={title} onClick={onCancel}>
      <div className="term-sheet tx-choice-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="term-sheet-head">
          <div>
            <div className="term-pin-title">{title}</div>
            {subtitle && <div className="term-pin-sub">{subtitle}</div>}
          </div>
          <button type="button" className="term-btn term-btn-ghost" onClick={onCancel}>
            Mégse
          </button>
        </div>
        {many && <TerminalSearch value={query} onChange={setQuery} total={choices.length} found={shown.length} />}
        {choices.length === 0 ? (
          <p className="term-sub">{emptyText}</p>
        ) : shown.length === 0 ? (
          <p className="term-sub">Nincs találat erre: „{query}”.</p>
        ) : (
          <div className="term-sheet-grid tx-choice-grid">
            {shown.map((c) => (
              <button key={c.key} type="button" className="term-choice" data-tone={c.tone} onClick={() => onChoose(c.key)}>
                {c.color && <span className="term-choice-dot" style={{ background: c.color }} aria-hidden="true" />}
                <span className="term-choice-label">{c.label}</span>
                {c.sub && <span className="term-choice-sub">{c.sub}</span>}
              </button>
            ))}
          </div>
        )}
        {footer && <div className="term-sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Search field of the terminal's lists: large, with a clear button and the number of matches. */
export function TerminalSearch({ value, onChange, total, found }: { value: string; onChange: (v: string) => void; total: number; found: number }) {
  return (
    <div className="tx-search">
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={`Keresés ${total} közül…`} aria-label="Keresés a listában" />
      {value && (
        <button type="button" className="term-btn term-btn-ghost" onClick={() => onChange("")}>
          Törlés
        </button>
      )}
      <span className="tx-search-count">{value ? `${found} találat` : `${total} elem`}</span>
    </div>
  );
}
