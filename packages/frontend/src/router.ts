import { useEffect, useState } from "react";

/**
 * Minimális kliensoldali router a History API-ra — függőség nélkül. Minden
 * nézetnek saját URL-je van (/production/work-orders), így működik a vissza
 * gomb, a könyvjelző és a link küldése.
 *
 * Production build esetén a webszervernek ismeretlen útvonalon is az
 * index.html-t kell kiszolgálnia (SPA fallback); a Vite dev szerver ezt
 * alapból megteszi.
 */
const EVENT = "mes:navigate";

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (path === window.location.pathname) return;
  if (options.replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(EVENT));
}

export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    window.addEventListener(EVENT, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(EVENT, update);
    };
  }, []);
  return path;
}
