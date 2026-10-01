/** Lapozó a szerveroldali listákhoz: "1–50 of 1,234", előző/következő, oldalméret. */
export default function Pager({
  offset,
  limit,
  total,
  onChange,
  pageSizes = [25, 50, 100, 200],
}: {
  offset: number;
  limit: number;
  total: number;
  onChange: (next: { offset: number; limit: number }) => void;
  pageSizes?: number[];
}) {
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + limit, total);
  return (
    <div className="ui-pager">
      <span className="num">
        {first.toLocaleString()}–{last.toLocaleString()} of {total.toLocaleString()}
      </span>
      <span className="ui-toolbar-spacer" />
      <label className="ui-check">
        Rows
        <select className="ui-select" value={limit} onChange={(e) => onChange({ offset: 0, limit: Number(e.target.value) })} aria-label="Rows per page">
          {pageSizes.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="ui-btn ui-btn-small" disabled={offset === 0} onClick={() => onChange({ offset: Math.max(0, offset - limit), limit })}>
        Previous
      </button>
      <button type="button" className="ui-btn ui-btn-small" disabled={offset + limit >= total} onClick={() => onChange({ offset: offset + limit, limit })}>
        Next
      </button>
    </div>
  );
}
