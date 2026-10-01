/** Közös dátum/idő/időtartam formázók — mindenhol ugyanúgy nézzen ki egy időpont. */

const dateTime = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const dateOnly = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : dateTime.format(d);
}

/** "YYYY-MM-DD" naptári nap — helyi dátumként, időzóna-eltolás nélkül. */
export function formatDate(day: string | null | undefined): string {
  if (!day) return "—";
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return day;
  return dateOnly.format(new Date(y, m - 1, d));
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const totalMinutes = Math.round(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** ISO → <input type="datetime-local"> érték, helyi időben. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> érték (helyi idő) → ISO, vagy null ha üres/érvénytelen. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** A határidő napjának vége (helyi idő) — ennél későbbi tervezett befejezés késés. */
export function endOfDay(day: string): number {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return new Date(y!, m! - 1, d! + 1).getTime();
}
