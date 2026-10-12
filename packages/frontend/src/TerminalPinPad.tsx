import { useEffect, useState } from "react";

/**
 * Teljes képernyős számbillentyűzet a dolgozó 5 jegyű kódjához. Érintésre
 * méretezve; a fizikai billentyűzet számai is működnek. Az ötödik szám után
 * magától beküldi.
 */
export default function TerminalPinPad({
  title,
  error,
  busy,
  onSubmit,
  onCancel,
}: {
  title: string;
  error: string | null;
  busy: boolean;
  onSubmit: (pin: string) => void;
  onCancel: () => void;
}) {
  const [digits, setDigits] = useState("");

  // A wrong code clears the field for the next try.
  useEffect(() => {
    if (error) setDigits("");
  }, [error]);

  function press(d: string) {
    if (busy || digits.length >= 5) return;
    const next = digits + d;
    setDigits(next);
    if (next.length === 5) onSubmit(next);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") setDigits((d) => d.slice(0, -1));
      else if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <div className="term-pin" role="dialog" aria-modal="true" aria-label="Kód megadása">
      <div className="term-pin-box">
        <div className="term-pin-title">{title}</div>
        <div className="term-pin-sub">Írd be a saját 5 jegyű kódodat</div>
        <div className="term-pin-dots" aria-live="polite" aria-label={`${digits.length} számjegy beírva`}>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} data-on={i < digits.length ? "true" : undefined} />
          ))}
        </div>
        <div className="term-pin-msg" role="alert">
          {busy ? "Ellenőrzés…" : error}
        </div>
        <div className="term-pin-keys">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
            <button key={d} type="button" onClick={() => press(d)} disabled={busy}>
              {d}
            </button>
          ))}
          <button type="button" className="term-pin-aux" onClick={onCancel}>
            Mégse
          </button>
          <button type="button" onClick={() => press("0")} disabled={busy}>
            0
          </button>
          <button type="button" className="term-pin-aux" onClick={() => setDigits((d) => d.slice(0, -1))} disabled={busy || digits.length === 0} aria-label="Törlés">
            ⌫
          </button>
        </div>
      </div>
    </div>
  );
}
