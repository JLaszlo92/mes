import { randomBytes } from "node:crypto";

/**
 * Egyszer használható, rövid életű ticketek a dashboard WebSocket
 * kapcsolatához.
 *
 * Böngészőből WebSocketen nem küldhető Authorization header, a session
 * tokent pedig nem akarjuk URL-be tenni (proxy-, szerver- és böngészőlogokba
 * kerülhet). Ehelyett a kliens egy hitelesített POST /api/auth/ws-ticket
 * hívással kér egy ticketet, és azzal csatlakozik: /ws?ticket=...
 * A ticket:
 *  - 256 bit véletlen, nem a session token, és abból nem is származtatható;
 *  - TICKET_TTL_MS-ig érvényes;
 *  - egyszer használható — a beváltás azonnal törli, így egy logba került
 *    URL már felhasznált, értéktelen ticketet tartalmaz.
 *
 * Tárolás memóriában: a backend egyetlen monolit processz, így nem kell hozzá
 * tábla. Újraindításkor a ki nem váltott ticketek elvesznek — ártalmatlan, a
 * kliens újracsatlakozáskor úgyis újat kér.
 */

export const TICKET_TTL_MS = 30_000;

/**
 * Egy WebSocket kapcsolat legfeljebb ennyi ideig él, utána a szerver
 * WS_CLOSE_REAUTH kóddal bontja, és a kliens új tickettel csatlakozik újra.
 * Ez korlátozza, meddig kaphat egy közben lejárt vagy visszavont session
 * még élő eseményeket: az új ticket kérése ilyenkor már 401-et ad.
 */
export const WS_MAX_LIFETIME_MS = 10 * 60_000;

/** Hiányzó, ismeretlen, már felhasznált vagy lejárt ticket. A frontend App.tsx-szel szinkronban tartandó. */
export const WS_CLOSE_INVALID_TICKET = 4401;
/** Lejárt a kapcsolat maximális élettartama — újracsatlakozás friss tickettel. A frontend App.tsx-szel szinkronban tartandó. */
export const WS_CLOSE_REAUTH = 4000;

/** Memóriavédelem: ennyi be nem váltott ticket felett nem adunk ki újat. */
const MAX_OUTSTANDING_TICKETS = 10_000;

interface TicketEntry {
  userId: string;
  expiresAt: number;
}

const tickets = new Map<string, TicketEntry>();

export class WsTicketCapacityError extends Error {
  constructor() {
    super("too many outstanding websocket tickets — try again shortly");
    this.name = "WsTicketCapacityError";
  }
}

function sweepExpired(now: number): void {
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt <= now) tickets.delete(ticket);
  }
}

// Időnkénti takarítás, hogy a be nem váltott ticketek ne halmozódjanak.
// unref(): ez a timer egymagában ne tartsa életben a processzt.
setInterval(() => sweepExpired(Date.now()), TICKET_TTL_MS).unref();

export function issueWsTicket(userId: string, now: number = Date.now()): { ticket: string; expiresAt: string } {
  if (tickets.size >= MAX_OUTSTANDING_TICKETS) {
    sweepExpired(now);
    if (tickets.size >= MAX_OUTSTANDING_TICKETS) throw new WsTicketCapacityError();
  }
  const ticket = randomBytes(32).toString("base64url");
  const expiresAt = now + TICKET_TTL_MS;
  tickets.set(ticket, { userId, expiresAt });
  return { ticket, expiresAt: new Date(expiresAt).toISOString() };
}

/** Beváltja és azonnal törli a ticketet. `undefined`, ha ismeretlen, már felhasznált vagy lejárt. */
export function redeemWsTicket(ticket: string, now: number = Date.now()): { userId: string } | undefined {
  const entry = tickets.get(ticket);
  if (!entry) return undefined;
  tickets.delete(ticket);
  if (entry.expiresAt <= now) return undefined;
  return { userId: entry.userId };
}
