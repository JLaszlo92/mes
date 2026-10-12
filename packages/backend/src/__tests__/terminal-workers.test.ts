import { describe, expect, it } from "vitest";
import { createWorkerTickets, WORKER_TICKET_SECONDS } from "../terminal-workers.js";

describe("worker tickets", () => {
  it("are bound to their terminal and expire after the idle time", () => {
    let t = 1_000_000;
    const tickets = createWorkerTickets(() => t);
    const { ticket } = tickets.issue("term-1", "u1");
    expect(tickets.use("term-2", ticket)).toBeUndefined();
    expect(tickets.use("term-1", ticket)?.userId).toBe("u1");
    t += (WORKER_TICKET_SECONDS - 1) * 1000; // used just in time: slides on
    expect(tickets.use("term-1", ticket)?.userId).toBe("u1");
    t += WORKER_TICKET_SECONDS * 1000 + 1;
    expect(tickets.use("term-1", ticket)).toBeUndefined();
  });
  it("one worker per terminal: a new unlock ends the previous ticket; lock ends it", () => {
    const tickets = createWorkerTickets();
    const first = tickets.issue("term-1", "u1").ticket;
    const second = tickets.issue("term-1", "u2").ticket;
    expect(tickets.use("term-1", first)).toBeUndefined();
    expect(tickets.use("term-1", second)?.userId).toBe("u2");
    tickets.end("term-1", second);
    expect(tickets.use("term-1", second)).toBeUndefined();
    expect(tickets.use("term-1", undefined)).toBeUndefined();
  });
});
