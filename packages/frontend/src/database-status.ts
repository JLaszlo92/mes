/**
 * State of the database as the dashboard knows it (chaos slice 10 follow-up).
 *
 * The backend answers HTTP 503 with `{ code: "database_unavailable" }` while Postgres cannot be reached.
 * apiFetch feeds every answer of our own backend in here; DatabaseBanner shows the state and probes
 * GET /health?db=1 until the database is back.
 *  - "ok":        nothing to show
 *  - "down":      a request was answered with database_unavailable
 *  - "recovered": it was down and works again; the data on the page may be stale, so the banner offers a reload
 */
export type DatabaseStatus = "ok" | "down" | "recovered";

let status: DatabaseStatus = "ok";
const listeners = new Set<() => void>();

export function getDatabaseStatus(): DatabaseStatus {
  return status;
}

export function subscribeDatabaseStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function set(next: DatabaseStatus): void {
  if (next === status) return;
  status = next;
  for (const l of [...listeners]) l();
}

/**
 * "Events cannot be stored" (chaos slice 23): the database answers, so no request of the dashboard fails, but every
 * event insert does (full disk). It is learned only from the periodic GET /health?db=1 of the banner, which then
 * answers 503 with code "ingestion_failing".
 */
let ingestionFailing = false;

export function getIngestionFailing(): boolean {
  return ingestionFailing;
}

export function setIngestionFailing(next: boolean): void {
  if (next === ingestionFailing) return;
  ingestionFailing = next;
  for (const l of [...listeners]) l();
}

/** True for the body of /health?db=1 while the backend cannot store events. */
export function isIngestionFailingBody(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { code?: unknown }).code === "ingestion_failing";
}

export function markDatabaseDown(): void {
  set("down");
}

/** Only meaningful after an outage: "ok" stays "ok". */
export function markDatabaseUp(): void {
  if (status === "down") set("recovered");
}

export function dismissDatabaseNotice(): void {
  if (status === "recovered") set("ok");
}

/** True for the body the backend sends while the database is unreachable. */
export function isDatabaseUnavailableBody(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { code?: unknown }).code === "database_unavailable";
}

/** Called by apiFetch for every answer of our own backend. */
export function noteDatabaseResponse(res: Response): void {
  if (res.status === 503) {
    res
      .clone()
      .json()
      .then((body: unknown) => {
        if (isDatabaseUnavailableBody(body)) markDatabaseDown();
      })
      .catch(() => undefined);
    return;
  }
  if (res.ok) markDatabaseUp();
}

/** For tests. */
export function resetDatabaseStatus(): void {
  status = "ok";
  ingestionFailing = false;
  listeners.clear();
}
