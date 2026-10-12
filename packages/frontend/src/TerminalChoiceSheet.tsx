import { useEffect, type ReactNode } from "react";

export interface Choice {
  key: string;
  label: string;
  sub?: string;
  /** A small colour mark (status colour). */
  color?: string | null;
  tone?: "alarm" | "neutral";
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="term-pin" role="dialog" aria-modal="true" aria-label={title} onClick={onCancel}>
      <div className="term-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="term-sheet-head">
          <div>
            <div className="term-pin-title">{title}</div>
            {subtitle && <div className="term-pin-sub">{subtitle}</div>}
          </div>
          <button type="button" className="term-btn term-btn-ghost" onClick={onCancel}>
            Mégse
          </button>
        </div>
        {choices.length === 0 ? (
          <p className="term-sub">{emptyText}</p>
        ) : (
          <div className="term-sheet-grid">
            {choices.map((c) => (
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
