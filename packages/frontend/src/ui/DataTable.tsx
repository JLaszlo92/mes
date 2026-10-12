import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Pager from "./Pager.js";

/**
 * Közös táblázat minden listához (gépek, és a többi panel fokozatosan).
 * Tud: rendezést oszlopfejlécre kattintva, sorkijelölést (tömeges
 * műveletekhez), sorra kattintást (szerkesztő megnyitása), soronkénti
 * műveleteket (csak hoverre/fókuszra látszanak), "halványított" sorokat
 * (pl. deaktivált gép).
 *
 * Szűrést/keresést NEM csinál — azt a hívó végzi, és csak a már szűrt sorokat
 * adja át. Így ugyanez a komponens működik kliensoldali szűréssel (néhány száz
 * gép) és később szerveroldali lapozással (audit log, leállások) is.
 *
 * Lapozás: alapból kliensoldali, 50 soros oldalakkal, ugyanazzal a lapozóval
 * (ui/Pager.tsx), mint a szerveroldalon lapozott listák (audit log, riasztás-
 * előzmények, hibajelentések) — azok `paging={false}`-t adnak, és maguk
 * rakják alá a Pagert. A választott oldalméretet táblázatonként megjegyzi
 * (localStorage, az ariaLabel a kulcs). A táblázat magassága korlátos
 * (.ui-table-wrap, 70vh), a fejléc görgetéskor fent marad.
 */

export interface Column<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Ha meg van adva, az oszlop rendezhető. */
  sortValue?: (row: T) => string | number | null;
  align?: "left" | "right";
  width?: number | string;
}

type SortState = { columnId: string; dir: "asc" | "desc" } | null;

interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  getRowId: (row: T) => string;
  /** Kijelölés — ha meg van adva, első oszlopként jelölőnégyzetek jelennek meg. */
  selected?: ReadonlySet<string>;
  onSelectedChange?: (next: Set<string>) => void;
  onRowClick?: (row: T) => void;
  rowActions?: (row: T) => ReactNode;
  isDimmed?: (row: T) => boolean;
  initialSort?: SortState;
  emptyText?: ReactNode;
  ariaLabel: string;
  /**
   * false: no paging here (the caller pages on the server). Otherwise
   * `resetKey` sends the table back to the first page when it changes; pass
   * the filter state, so a new search does not land on page 4 of the result.
   */
  paging?: false | { resetKey?: unknown; pageSize?: number };
}

const PAGE_SIZES = [25, 50, 100, 200];

function storedPageSize(key: string, fallback: number): number {
  try {
    const n = Number(localStorage.getItem(key));
    return PAGE_SIZES.includes(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compare(a: string | number | null, b: string | number | null): number {
  // Üres értékek mindig a lista végére kerülnek, iránytól függetlenül (lent kezelve).
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator.compare(String(a), String(b));
}

export default function DataTable<T>({
  rows,
  columns,
  getRowId,
  selected,
  onSelectedChange,
  onRowClick,
  rowActions,
  isDimmed,
  initialSort = null,
  emptyText = "Nothing to show.",
  ariaLabel,
  paging = {},
}: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState>(initialSort);
  const sizeKey = `mes-page-size:${ariaLabel}`;
  const [limit, setLimit] = useState(() => (paging ? storedPageSize(sizeKey, paging.pageSize ?? 50) : Infinity));
  const [offset, setOffset] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  // New filters or another sort order: back to the first page.
  const resetKey = paging ? JSON.stringify(paging.resetKey ?? null) : "";
  useEffect(() => setOffset(0), [resetKey, sort?.columnId, sort?.dir]);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.id === sort.columnId);
    if (!column?.sortValue) return rows;
    const value = column.sortValue;
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((ra, rb) => {
      const a = value(ra);
      const b = value(rb);
      const aEmpty = a === null || a === "";
      const bEmpty = b === null || b === "";
      if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
      return compare(a, b) * factor;
    });
  }, [rows, columns, sort]);

  // Rows vanished (a refresh, a filter): stay on the last page that still exists.
  const total = sortedRows.length;
  const safeOffset = !paging || offset < total ? offset : Math.max(0, Math.floor((total - 1) / limit) * limit);
  const pageRows = paging ? sortedRows.slice(safeOffset, safeOffset + limit) : sortedRows;

  function changePage(next: { offset: number; limit: number }) {
    setOffset(next.offset);
    if (next.limit !== limit) {
      setLimit(next.limit);
      try {
        localStorage.setItem(sizeKey, String(next.limit));
      } catch {
        // A blocked storage only costs remembering the choice.
      }
    }
    wrapRef.current?.scrollTo({ top: 0 });
  }

  const selectable = selected !== undefined && onSelectedChange !== undefined;
  const visibleIds = pageRows.map(getRowId);
  const selectedVisible = selectable ? visibleIds.filter((id) => selected.has(id)).length : 0;
  const allSelected = selectable && visibleIds.length > 0 && selectedVisible === visibleIds.length;

  function toggleAll() {
    if (!selectable) return;
    const next = new Set(selected);
    if (allSelected) visibleIds.forEach((id) => next.delete(id));
    else visibleIds.forEach((id) => next.add(id));
    onSelectedChange(next);
  }

  function toggleRow(id: string) {
    if (!selectable) return;
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  }

  function cycleSort(column: Column<T>) {
    if (!column.sortValue) return;
    setSort((prev) => {
      if (!prev || prev.columnId !== column.id) return { columnId: column.id, dir: "asc" };
      if (prev.dir === "asc") return { columnId: column.id, dir: "desc" };
      return null;
    });
  }

  const colSpan = columns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0);

  return (
    <>
    <div className="ui-table-wrap" ref={wrapRef}>
      <table className="ui-table" aria-label={ariaLabel}>
        <thead>
          <tr>
            {selectable && (
              <th className="ui-col-check">
                <input
                  type="checkbox"
                  aria-label="Select all shown rows"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = selectedVisible > 0 && !allSelected;
                  }}
                  onChange={toggleAll}
                />
              </th>
            )}
            {columns.map((c) => {
              const sortDir = sort?.columnId === c.id ? sort.dir : null;
              return (
                <th
                  key={c.id}
                  style={{ width: c.width }}
                  className={c.align === "right" ? "ui-col-right" : undefined}
                  aria-sort={c.sortValue ? (sortDir === "asc" ? "ascending" : sortDir === "desc" ? "descending" : "none") : undefined}
                  onClick={() => cycleSort(c)}
                  tabIndex={c.sortValue ? 0 : undefined}
                  onKeyDown={(e) => {
                    if (c.sortValue && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      cycleSort(c);
                    }
                  }}
                >
                  {c.header}
                  {sortDir && <span aria-hidden="true">{sortDir === "asc" ? " ↑" : " ↓"}</span>}
                </th>
              );
            })}
            {rowActions && <th className="ui-row-actions" aria-label="Actions" />}
          </tr>
        </thead>
        <tbody>
          {pageRows.length === 0 && (
            <tr>
              <td colSpan={colSpan} className="ui-table-empty">
                {emptyText}
              </td>
            </tr>
          )}
          {pageRows.map((row) => {
            const id = getRowId(row);
            const isSelected = selectable && selected.has(id);
            return (
              <tr
                key={id}
                aria-selected={selectable ? isSelected : undefined}
                data-dimmed={isDimmed?.(row) ? "true" : undefined}
                data-clickable={onRowClick ? "true" : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={() => onRowClick?.(row)}
                onKeyDown={(e) => {
                  if (onRowClick && e.key === "Enter" && e.target === e.currentTarget) onRowClick(row);
                }}
              >
                {selectable && (
                  <td className="ui-col-check" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`Select ${id}`} checked={isSelected} onChange={() => toggleRow(id)} />
                  </td>
                )}
                {columns.map((c) => (
                  <td key={c.id} className={c.align === "right" ? "ui-col-right num" : undefined}>
                    {c.cell(row)}
                  </td>
                ))}
                {rowActions && (
                  <td className="ui-row-actions" onClick={(e) => e.stopPropagation()}>
                    <span style={{ display: "inline-flex", gap: 4 }}>{rowActions(row)}</span>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    {paging && total > 0 && <Pager offset={safeOffset} limit={limit} total={total} onChange={changePage} pageSizes={PAGE_SIZES} />}
    </>
  );
}
