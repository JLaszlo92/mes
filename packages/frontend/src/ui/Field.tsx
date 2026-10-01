import type { ReactNode } from "react";

/** Címkézett űrlapmező hibaüzenettel vagy súgóval. A hiba elsőbbséget élvez. */
export default function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <label className="ui-field">
      <span className="ui-field-label">{label}</span>
      {children}
      {error ? <span className="ui-field-error">{error}</span> : hint ? <span className="ui-field-hint">{hint}</span> : null}
    </label>
  );
}
