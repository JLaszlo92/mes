/**
 * Központi, hitelesített fetch a backend API-hoz.
 *
 * A backend auth guardja deny-by-default: token nélkül minden route 401-et
 * ad, az olvasások is. Ahelyett, hogy minden panel maga rakná össze az
 * Authorization headert (és egy új panel ezt elfelejthesse), minden
 * API-hívás az `apiFetch`-en megy át, ami:
 *
 *  - automatikusan hozzáteszi a session tokent, ha a kérés a saját
 *    backendünkre megy (API_BASE) — más originre (pl. egy munkautasítás
 *    külső PDF linkje) a token soha nem kerül ki;
 *  - egy kifejezetten megadott Authorization headert nem ír felül;
 *  - 401-re, ha tokennel ment a kérés, értesíti az AuthProvidert, ami
 *    kilépteti a felhasználót (lejárt vagy visszavont session).
 *
 * Aláírása azonos a `fetch`-ével, így a meglévő hívások csak átnevezést
 * igényelnek. A login/logout hívások szándékosan sima `fetch`-et használnak
 * (auth-context.tsx), hogy egy lejárt tokenes logout ne indítson újabb
 * kiléptetést.
 */

import { noteDatabaseResponse } from "./database-status.js";

export const WS_URL = import.meta.env.VITE_BACKEND_WS_URL ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
export const API_BASE = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");

let currentToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

/** Az AuthProvider hívja szinkronban, minden auth-állapotváltáskor. */
export function setApiToken(token: string | null): void {
  currentToken = token;
}

/** Az AuthProvider regisztrálja; 401 esetén hívódik. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isBackendUrl(url: string): boolean {
  return url === API_BASE || url.startsWith(`${API_BASE}/`);
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = currentToken;
  const attach = token !== null && isBackendUrl(requestUrl(input));

  let finalInit = init;
  if (attach) {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
    finalInit = { ...init, headers };
  }

  const res = await fetch(input, finalInit);
  if (attach && res.status === 401) onUnauthorized?.();
  if (isBackendUrl(requestUrl(input))) noteDatabaseResponse(res);
  return res;
}
