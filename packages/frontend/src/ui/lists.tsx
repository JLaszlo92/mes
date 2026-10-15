import { useMemo, useState, type ReactNode } from "react";

/**
 * Hosszú listák kezelése a táblázatokon (DataTable) kívül — egy helyen, hogy
 * 0, 1, néhány és nagyon sok elemnél is ugyanúgy viselkedjenek:
 *
 * - `useCapped` / `MoreToggle`: az első N elem, alatta "Show all (N)" /
 *   "Show fewer" (oldalsó panelek szakaszai, kis listák, idővonal-listák).
 * - `FilterSelect`: legördülő lista, amely sok elemnél keresőmezőt kap, és
 *   egyszerre legfeljebb `max` találatot mutat (anyagtételek, munkautasítások…).
 * - `CheckList`: jelölőnégyzet-lista (pl. gépek), sok elemnél kereséssel,
 *   "mind / egyik sem" gombokkal, korlátozott magassággal.
 * - `matches`: kis- és nagybetű, ékezet nélküli keresés (a "hegeszto" megtalálja a "Hegesztő"-t).
 */

/** Lowercase without accents, for search. */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Every word of the query is somewhere in the text (case- and accent-insensitive). */
export function matches(text: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fold(text);
  return words.every((w) => hay.includes(w));
}

/**
 * The first `limit` items, or all of them once expanded. `fromEnd`: the last ones (newest at the end). A list only
 * one item longer than the limit is shown whole — a "Show all (N)" button for one more line is noise.
 */
export function useCapped<T>(items: readonly T[], limit: number, options: { fromEnd?: boolean } = {}) {
  const [expanded, setExpanded] = useState(false);
  const capped = !expanded && items.length > limit + 1;
  const visible = capped ? (options.fromEnd ? items.slice(items.length - limit) : items.slice(0, limit)) : items;
  return {
    visible: visible as T[],
    toggle: <MoreToggle total={items.length} shown={visible.length} expanded={expanded} onToggle={() => setExpanded((e) => !e)} />,
  };
}

export function MoreToggle({ total, shown, expanded, onToggle, noun = "" }: { total: number; shown: number; expanded: boolean; onToggle: () => void; noun?: string }) {
  if (!expanded && shown >= total) return null;
  return (
    <button type="button" className="ui-btn ui-btn-small ui-btn-ghost ui-more" onClick={onToggle} aria-expanded={expanded}>
      {expanded ? "Show fewer" : `Show all ${total}${noun ? ` ${noun}` : ""} (${total - shown} more)`}
    </button>
  );
}

/** A list with an empty text, capped at `limit` with a "Show all" toggle. */
export function CappedList<T>({
  items,
  limit = 8,
  render,
  empty,
  className,
  fromEnd,
  footer,
}: {
  items: readonly T[];
  limit?: number;
  render: (item: T, index: number) => ReactNode;
  empty: ReactNode;
  className?: string;
  fromEnd?: boolean;
  /** Below the list (e.g. "the latest 20 are shown"). */
  footer?: ReactNode;
}) {
  const { visible, toggle } = useCapped(items, limit, { fromEnd });
  if (items.length === 0) return <p className="ui-field-hint ui-empty-line">{empty}</p>;
  return (
    <>
      <ul className={className}>{visible.map((item, i) => render(item, i))}</ul>
      <div className="ui-more-row">
        {toggle}
        {footer}
      </div>
    </>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * A select that stays usable with thousands of options: from `threshold` options on, a search field narrows them and
 * at most `max` are listed (the chosen one always stays). Below the threshold it is a plain select.
 */
export function FilterSelect({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  threshold = 15,
  max = 200,
  disabled,
  className = "ui-select",
  id,
  invalid,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  /** The empty first option ("Choose…"); omitted when not given. */
  placeholder?: string;
  ariaLabel: string;
  threshold?: number;
  max?: number;
  disabled?: boolean;
  className?: string;
  id?: string;
  invalid?: boolean;
}) {
  const [query, setQuery] = useState("");
  const many = options.length >= threshold;
  const found = useMemo(() => (many && query ? options.filter((o) => matches(o.label, query)) : options), [options, query, many]);
  const shown = found.slice(0, max);
  const chosen = options.find((o) => o.value === value);
  if (chosen && !shown.includes(chosen)) shown.unshift(chosen);
  const hidden = found.length - Math.min(found.length, max);
  return (
    <span className="ui-filter-select">
      {many && (
        <input
          className="ui-input"
          type="search"
          placeholder={`Search ${options.length}…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={`${ariaLabel}: search`}
          disabled={disabled}
        />
      )}
      <select id={id} className={className} value={value} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel} disabled={disabled} aria-invalid={invalid || undefined}>
        {placeholder !== undefined && <option value="">{many && query ? `${found.length} found — ${placeholder}` : placeholder}</option>}
        {shown.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {hidden > 0 && (
          <option value="__more" disabled>
            … {hidden} more — type to narrow the list
          </option>
        )}
        {many && query && found.length === 0 && (
          <option value="__none" disabled>
            Nothing matches “{query}”
          </option>
        )}
      </select>
    </span>
  );
}

/**
 * Checkboxes for a set of items (machines of a terminal, of an alert rule). From `threshold` items on: a search field,
 * "all shown" / "none", the selected count; the list scrolls inside a fixed height.
 */
export function CheckList({
  items,
  selected,
  onChange,
  ariaLabel,
  threshold = 10,
  empty = "Nothing to choose from.",
  disabled,
}: {
  items: readonly { id: string; label: string; sub?: string }[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  ariaLabel: string;
  threshold?: number;
  empty?: ReactNode;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const many = items.length >= threshold;
  const shown = many && query ? items.filter((i) => matches(`${i.label} ${i.sub ?? ""}`, query)) : items;
  const set = new Set(selected);
  if (items.length === 0) return <p className="ui-field-hint ui-empty-line">{empty}</p>;
  return (
    <div className="ui-checklist" data-many={many ? "true" : undefined}>
      {many && (
        <div className="ui-checklist-bar">
          <input className="ui-input" type="search" placeholder={`Search ${items.length}…`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={`${ariaLabel}: search`} />
          <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" disabled={disabled || shown.length === 0} onClick={() => onChange([...new Set([...selected, ...shown.map((i) => i.id)])])}>
            {query ? "Select found" : "Select all"}
          </button>
          <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" disabled={disabled || selected.length === 0} onClick={() => onChange(query ? selected.filter((id) => !shown.some((i) => i.id === id)) : [])}>
            {query ? "Clear found" : "Clear"}
          </button>
          <span className="ui-field-hint">
            {selected.length} of {items.length} selected
          </span>
        </div>
      )}
      <div className="ui-checklist-items" role="group" aria-label={ariaLabel}>
        {shown.map((i) => (
          <label key={i.id} className="ui-check">
            <input type="checkbox" checked={set.has(i.id)} disabled={disabled} onChange={() => onChange(set.has(i.id) ? selected.filter((x) => x !== i.id) : [...selected, i.id])} />
            {i.label}
            {i.sub && <span className="ui-sub">{i.sub}</span>}
          </label>
        ))}
        {shown.length === 0 && <span className="ui-field-hint">Nothing matches “{query}”.</span>}
      </div>
    </div>
  );
}

/** Render-prop form of `useCapped`, for lists inside a loop (where a hook cannot be called). */
export function Capped<T>({ items, limit, fromEnd, children }: { items: readonly T[]; limit: number; fromEnd?: boolean; children: (visible: T[]) => ReactNode }) {
  const { visible, toggle } = useCapped(items, limit, { fromEnd });
  return (
    <>
      {children(visible)}
      {toggle && <div className="ui-more-row">{toggle}</div>}
    </>
  );
}
