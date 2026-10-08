import { useEffect, useSyncExternalStore } from "react";
import { API_BASE } from "./api.js";
import { dismissDatabaseNotice, getDatabaseStatus, markDatabaseUp, subscribeDatabaseStatus } from "./database-status.js";
import "./database-banner.css";

const PROBE_INTERVAL_MS = 5000;

/**
 * Shown below the top bar while the backend cannot reach its database. While it is down the banner asks
 * GET /health?db=1 every few seconds, so it notices the recovery even if no panel refreshes by itself.
 */
export default function DatabaseBanner() {
  const status = useSyncExternalStore(subscribeDatabaseStatus, getDatabaseStatus);

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

  if (status === "ok") return null;

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
