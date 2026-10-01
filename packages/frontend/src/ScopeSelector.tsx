import { useEffect, useRef, useState } from "react";
import { useScope } from "./scope.js";

/**
 * A felső sáv hatókör-választója: gomb az aktuális hatókörrel, kattintásra
 * kis panel három lépcsőzetes választóval. Az alsóbb szint mindig a felette
 * lévőhöz igazodik.
 */
export default function ScopeSelector() {
  const { scope, setScope, hierarchy, label, isFiltered } = useScope();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const areas = hierarchy.areas.filter((a) => !scope.siteId || a.siteId === scope.siteId);
  const lines = hierarchy.lines.filter((l) => (scope.areaId ? l.areaId === scope.areaId : areas.some((a) => a.id === l.areaId)));
  const siteOfArea = (areaId: string) => hierarchy.areas.find((a) => a.id === areaId)?.siteId ?? null;
  const areaOfLine = (lineId: string) => hierarchy.lines.find((l) => l.id === lineId)?.areaId ?? null;

  return (
    <div className="scope" ref={rootRef}>
      <button
        type="button"
        className="scope-btn"
        data-filtered={isFiltered ? "true" : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="scope-btn-label">{label}</span>
        <span className="shell-chevron" data-open={open ? "true" : undefined} aria-hidden="true" />
      </button>
      {open && (
        <div className="scope-panel" role="dialog" aria-label="Choose site, area and line">
          <label className="ui-field">
            <span className="ui-field-label">Site</span>
            <select
              className="ui-select"
              value={scope.siteId ?? ""}
              onChange={(e) => setScope({ siteId: e.target.value || null, areaId: null, lineId: null })}
              autoFocus
            >
              <option value="">All sites</option>
              {hierarchy.sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="ui-field">
            <span className="ui-field-label">Area</span>
            <select
              className="ui-select"
              value={scope.areaId ?? ""}
              onChange={(e) => {
                const areaId = e.target.value || null;
                setScope({ siteId: areaId ? siteOfArea(areaId) : scope.siteId, areaId, lineId: null });
              }}
            >
              <option value="">All areas</option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="ui-field">
            <span className="ui-field-label">Line</span>
            <select
              className="ui-select"
              value={scope.lineId ?? ""}
              onChange={(e) => {
                const lineId = e.target.value || null;
                const areaId = lineId ? areaOfLine(lineId) : scope.areaId;
                setScope({ siteId: areaId ? siteOfArea(areaId) : scope.siteId, areaId, lineId });
              }}
            >
              <option value="">All lines</option>
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" disabled={!isFiltered} onClick={() => setScope({ siteId: null, areaId: null, lineId: null })}>
              Show everything
            </button>
            <span style={{ flex: 1 }} />
            <button type="button" className="ui-btn ui-btn-small" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
