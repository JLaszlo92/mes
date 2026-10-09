import { useEffect, useSyncExternalStore } from "react";
import { API_BASE } from "./api.js";
import {
  dismissDatabaseNotice,
  getDatabaseStatus,
  getIngestionFailing,
  isIngestionFailingBody,
  markDatabaseUp,
  setIngestionFailing,
  subscribeDatabaseStatus,
} from "./database-status.js";
import { usePolling } from "./ui/usePolling.js";
import "./database-banner.css";

const PROBE_INTERVAL_MS = 5000;
/** The slow check for "events cannot be stored", and the faster one while it lasts (to see the recovery). */
const INGESTION_CHECK_MS = 30_000;
const INGESTION_CHECK_FAILING_MS = 10_000;

/**
 * Shown below the top bar while the backend cannot reach its database. While it is down the banner asks
 * GET /health?db=1 every few seconds, so it notices the recovery even if no panel refreshes by itself.
 */
export default function DatabaseBanner() {
  const status = useSyncExternalStore(subscribeDatabaseStatus, getDatabaseStatus);
  const ingestionFailing = useSyncExternalStore(subscribeDatabaseStatus, getIngestionFailing);

  // The database answers but cannot store events (full disk): no request fails, so ask /health?db=1 now and then.
  // A database that cannot be reached is the "down" banner's job; a network error keeps what is shown.
  const checkIngestion = () => {
    fetch(`${API_BASE}/health?db=1`, { cache: "no-store" })
      .then(async (res) => {
        if (res.ok) {
          setIngestionFailing(false);
          return;
        }
        if (res.status !== 503) return;
        const body: unknown = await res.json().catch(() => null);
        if (isIngestionFailingBody(body)) setIngestionFailing(true);
      })
      .catch(() => undefined);
  };
  useEffect(() => {
    checkIngestion();
  }, []);
  usePolling(checkIngestion, ingestionFailing ? INGESTION_CHECK_FAILING_MS : INGESTION_CHECK_MS);

  useEffect(() => {
    if (status !== "down") return;
    let cancelled = false;
    const probe = async () => {
      try {
        const res = await fetch(`${API_BASE}/health?db=1`, { cache: "no-store" });
        if (!cancelled && res.ok) markDatabaseUp();
      } catch {
        /* the backend itself cannot be reached either: keep the banner */
      }
    };
    const timer = setInterval(() => void probe(), PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [status]);

  if (status === "ok" && !ingestionFailing) return null;

  if (status === "down") {
    return (
      <div className="db-banner" data-state="down" role="alert">
        <strong>Database unavailable.</strong>
        <span>
          The data on this page may be out of date and changes cannot be saved. The system retries automatically; edge devices keep
          buffering their events.
        </span>
      </div>
    );
  }

  if (ingestionFailing) {
    return (
      <div className="db-banner" data-state="down" role="alert">
        <strong>Events cannot be stored.</strong>
        <span>
          The database answers but refuses to write (most likely the disk is full). Edge devices keep buffering their events;
          free up disk space — see the Alerts page.
        </span>
      </div>
    );
  }

  return (
    <div className="db-banner" data-state="recovered" role="status">
      <strong>The database is available again.</strong>
      <span>Reload the page to refresh the data.</span>
      <span className="db-banner-actions">
        <button type="button" className="ui-btn ui-btn-small" onClick={() => window.location.reload()}>
          Reload
        </button>
        <button type="button" className="ui-btn ui-btn-small" onClick={dismissDatabaseNotice}>
          Dismiss
        </button>
      </span>
    </div>
  );
}
