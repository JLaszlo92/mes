import { useEffect, useRef } from "react";

/**
 * Calls `callback` every `intervalMs` while the tab is visible, and once more
 * as soon as the tab becomes visible again (a hidden tab does not poll).
 * `enabled=false` pauses it, for example while the user is editing and a
 * reload must not disturb the form.
 */
export function usePolling(callback: () => void, intervalMs: number, enabled = true): void {
  const latest = useRef(callback);
  latest.current = callback;

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (document.visibilityState === "visible") latest.current();
    };
    const timer = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [intervalMs, enabled]);
}
