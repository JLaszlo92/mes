import { createHash, randomBytes } from "node:crypto";

/**
 * Dolgozói jegyek a terminálon: egy helyes PIN után a terminál kap egy
 * rövid életű jegyet, amellyel a dolgozó nevében dolgozhat. Minden
 * sikeres művelet meghosszabbítja (csúszó ablak); a "Kilépés" törli.
 *
 * Memóriában (egyfolyamatos backend, mint a ws-tickets): egy újraindítás
 * után a dolgozó újra beírja a PIN-t, ami ártalmatlan. Csak a jegy SHA-256-ja
 * a kulcs, és a jegy egy terminálhoz kötött.
 */
export const WORKER_TICKET_SECONDS = 60;
const MAX_TICKETS = 2000;

interface Entry {
  terminalId: string;
  userId: string;
  expiresAt: number;
}

export function createWorkerTickets(now: () => number = Date.now) {
  const tickets = new Map<string, Entry>();
  const hash = (t: string) => createHash("sha256").update(t).digest("hex");

  function sweep() {
    const t = now();
    for (const [k, e] of tickets) if (e.expiresAt <= t) tickets.delete(k);
  }

  return {
    /** A new ticket for this worker at this terminal; earlier tickets of the terminal end (one worker at a time). */
    issue(terminalId: string, userId: string): { ticket: string; expiresAt: number } {
      sweep();
      for (const [k, e] of tickets) if (e.terminalId === terminalId) tickets.delete(k);
      if (tickets.size >= MAX_TICKETS) throw new Error("too many open terminal sessions");
      const ticket = randomBytes(24).toString("base64url");
      const expiresAt = now() + WORKER_TICKET_SECONDS * 1000;
      tickets.set(hash(ticket), { terminalId, userId, expiresAt });
      return { ticket, expiresAt };
    },
    /** The worker of a valid ticket for this terminal; extends it. */
    use(terminalId: string, ticket: string | undefined): { userId: string; expiresAt: number } | undefined {
      if (!ticket) return undefined;
      const key = hash(ticket);
      const e = tickets.get(key);
      if (!e || e.terminalId !== terminalId) return undefined;
      if (e.expiresAt <= now()) {
        tickets.delete(key);
        return undefined;
      }
      e.expiresAt = now() + WORKER_TICKET_SECONDS * 1000;
      return { userId: e.userId, expiresAt: e.expiresAt };
    },
    end(terminalId: string, ticket: string | undefined): void {
      if (!ticket) return;
      const key = hash(ticket);
      if (tickets.get(key)?.terminalId === terminalId) tickets.delete(key);
    },
    size: () => tickets.size,
  };
}

export const workerTickets = createWorkerTickets();
