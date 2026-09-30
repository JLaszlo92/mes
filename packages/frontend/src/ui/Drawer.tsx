import { useEffect, useRef, type ReactNode } from "react";

/**
 * Jobbról beúszó oldalpanel. A lista mögötte látszik, így egymás után több
 * elemet is gyorsan lehet szerkeszteni. Esc és a háttérre kattintás az
 * onRequestClose-t hívja — a hívó dönti el, hogy mentetlen változásnál
 * rákérdez-e.
 */
export default function Drawer({
  title,
  subtitle,
  onRequestClose,
  footer,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onRequestClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onRequestClose);
  closeRef.current = onRequestClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Az első szerkeszthető mezőre fókuszál, különben magára a panelre.
    const first = panelRef.current?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled])");
    (first ?? panelRef.current)?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
    }
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <>
      <div className="ui-drawer-backdrop" onClick={() => closeRef.current()} />
      <div className="ui-drawer" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} ref={panelRef} tabIndex={-1}>
        <div className="ui-drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 className="ui-drawer-title">{title}</h2>
            {subtitle && <span className="ui-sub">{subtitle}</span>}
          </div>
          <button type="button" className="ui-btn ui-btn-ghost" onClick={() => closeRef.current()} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="ui-drawer-body">{children}</div>
        {footer && <div className="ui-drawer-foot">{footer}</div>}
      </div>
    </>
  );
}
