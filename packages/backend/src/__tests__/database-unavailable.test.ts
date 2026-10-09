import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  databaseTargetFromUrl,
  isDatabaseUnavailable,
  isDatabaseWriteFailure,
  registerDatabaseUnavailableHandler,
} from "../database-unavailable.js";

const refused = (port = 5432) => Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${port}`), { code: "ECONNREFUSED", port, address: "127.0.0.1", syscall: "connect" });
const target = { host: "localhost", port: 5432 };

describe("databaseTargetFromUrl", () => {
  it("reads host and port, defaults the port, and gives up on sockets and garbage", () => {
    expect(databaseTargetFromUrl("postgres://u:p@db.local:5433/mes")).toEqual({ host: "db.local", port: 5433 });
    expect(databaseTargetFromUrl("postgres://u:p@localhost/mes")).toEqual({ host: "localhost", port: 5432 });
    expect(databaseTargetFromUrl("postgres:///mes?host=/var/run/postgresql")).toBeNull();
    expect(databaseTargetFromUrl("not a url")).toBeNull();
    expect(databaseTargetFromUrl(undefined)).toBeNull();
  });
});

describe("isDatabaseUnavailable", () => {
  it("recognises a refused connection to the database port, also inside an AggregateError (localhost has two addresses)", () => {
    expect(isDatabaseUnavailable(refused(), target)).toBe(true);
    const agg = Object.assign(new AggregateError([refused(), refused()], "x"), { code: "ECONNREFUSED" });
    expect(isDatabaseUnavailable(agg, target)).toBe(true);
    expect(isDatabaseUnavailable(new AggregateError([refused()], "x"), target)).toBe(true);
  });

  it("does not take a refused connection to ANOTHER port for the database", () => {
    expect(isDatabaseUnavailable(refused(8884), target)).toBe(false);
    expect(isDatabaseUnavailable(Object.assign(new Error("getaddrinfo ENOTFOUND other"), { code: "ENOTFOUND", hostname: "other" }), target)).toBe(false);
    expect(isDatabaseUnavailable(Object.assign(new Error("x"), { code: "ECONNREFUSED" }), target)).toBe(false);
  });

  it("trusts the code when the target is unknown", () => {
    expect(isDatabaseUnavailable(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(true);
  });

  it("recognises the SQLSTATEs of a shutdown, a restart and a lost connection", () => {
    for (const code of ["57P01", "57P02", "57P03", "08000", "08006", "08001", "53300"]) {
      expect(isDatabaseUnavailable(Object.assign(new Error("pg"), { code }))).toBe(true);
    }
  });

  it("recognises the messages of the pg driver", () => {
    for (const message of [
      "Connection terminated unexpectedly",
      "Connection terminated",
      "timeout exceeded when trying to connect",
      "Client has encountered a connection error and is not queryable",
      "terminating connection due to administrator command",
      "the database system is starting up",
      "the database system is shutting down",
    ]) {
      expect(isDatabaseUnavailable(new Error(message))).toBe(true);
    }
  });

  it("follows the cause chain", () => {
    expect(isDatabaseUnavailable(new Error("query failed", { cause: Object.assign(new Error("x"), { code: "57P01" }) }))).toBe(true);
  });

  it("does not take ordinary errors for an outage", () => {
    expect(isDatabaseUnavailable(new Error("boom"))).toBe(false);
    expect(isDatabaseUnavailable(Object.assign(new Error('duplicate key value violates unique constraint "x"'), { code: "23505" }))).toBe(false);
    expect(isDatabaseUnavailable(Object.assign(new Error('relation "x" does not exist'), { code: "42P01" }))).toBe(false);
    expect(isDatabaseUnavailable(null)).toBe(false);
    expect(isDatabaseUnavailable("ECONNREFUSED")).toBe(false);
  });
});

describe("registerDatabaseUnavailableHandler", () => {
  async function build(nowMs?: () => number) {
    const app = Fastify();
    registerDatabaseUnavailableHandler(app, "postgres://u:p@localhost:5432/mes", nowMs);
    app.get("/down", async () => { throw refused(); });
    app.get("/boom", async () => { throw new Error("boom"); });
    app.get("/bad", async () => { throw Object.assign(new Error("bad input"), { statusCode: 400 }); });
    app.post("/v", { schema: { body: { type: "object", required: ["a"], properties: { a: { type: "string" } } } } }, async () => "ok");
    await app.register(async (child) => {
      child.get("/child", async () => { throw Object.assign(new Error("pg"), { code: "57P01" }); });
    });
    await app.ready();
    return app;
  }

  it("answers 503 with Retry-After and a code for a database outage", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/down" });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
    expect(res.json()).toEqual({ error: "database unavailable", code: "database_unavailable" });
    await app.close();
  });

  it("also covers routes registered in an encapsulated plugin", async () => {
    const app = await build();
    expect((await app.inject({ method: "GET", url: "/child" })).statusCode).toBe(503);
    await app.close();
  });

  it("leaves every other answer as Fastify gives it", async () => {
    const app = await build();
    const boom = await app.inject({ method: "GET", url: "/boom" });
    expect(boom.statusCode).toBe(500);
    expect(boom.json().error).toBe("Internal Server Error");
    expect((await app.inject({ method: "GET", url: "/bad" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v", payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/nope" })).statusCode).toBe(404);
    await app.close();
  });

  it("logs the outage at most once every 10 seconds", async () => {
    let t = 1_000_000;
    const app = Fastify({ logger: false });
    const warns: unknown[] = [];
    app.log.warn = ((...args: unknown[]) => { warns.push(args); }) as never;
    registerDatabaseUnavailableHandler(app, undefined, () => t);
    app.get("/down", async () => { throw refused(); });
    await app.ready();
    for (let i = 0; i < 5; i += 1) await app.inject({ method: "GET", url: "/down" });
    expect(warns).toHaveLength(1);
    t += 10_001;
    await app.inject({ method: "GET", url: "/down" });
    expect(warns).toHaveLength(2);
    expect((warns[1] as [{ suppressed: number }])[0].suppressed).toBe(4);
    await app.close();
  });
});

describe("isDatabaseWriteFailure", () => {
  it("recognises a full disk, out of memory and a read-only transaction by SQLSTATE", () => {
    for (const code of ["53000", "53100", "53200", "25006"]) {
      expect(isDatabaseWriteFailure(Object.assign(new Error("pg"), { code }))).toBe(true);
    }
  });

  it("recognises the messages when there is no SQLSTATE, also in the cause chain", () => {
    expect(isDatabaseWriteFailure(new Error('could not extend file "base/16384/2619": No space left on device'))).toBe(true);
    expect(isDatabaseWriteFailure(new Error("cannot execute INSERT in a read-only transaction"))).toBe(true);
    expect(isDatabaseWriteFailure(new Error("query failed", { cause: Object.assign(new Error("x"), { code: "53100" }) }))).toBe(true);
  });

  it("does not take ordinary errors, constraint violations or an outage for a write failure", () => {
    expect(isDatabaseWriteFailure(new Error("boom"))).toBe(false);
    expect(isDatabaseWriteFailure(Object.assign(new Error("dup"), { code: "23505" }))).toBe(false);
    expect(isDatabaseWriteFailure(Object.assign(new Error("too many connections"), { code: "53300" }))).toBe(false);
    expect(isDatabaseWriteFailure(refused())).toBe(false);
    expect(isDatabaseWriteFailure(null)).toBe(false);
  });
});

describe("registerDatabaseUnavailableHandler - write failures", () => {
  async function build() {
    const app = Fastify();
    registerDatabaseUnavailableHandler(app, "postgres://u:p@localhost:5432/mes");
    app.get("/full", async () => { throw Object.assign(new Error('could not extend file "base/1/2": No space left on device'), { code: "53100" }); });
    app.get("/readonly", async () => { throw Object.assign(new Error("cannot execute INSERT in a read-only transaction"), { code: "25006" }); });
    app.get("/down", async () => { throw refused(); });
    app.get("/toomany", async () => { throw Object.assign(new Error("sorry, too many clients already"), { code: "53300" }); });
    await app.register(async (child) => {
      child.get("/child-full", async () => { throw Object.assign(new Error("pg"), { code: "53100" }); });
    });
    await app.ready();
    return app;
  }

  it("answers 503 database_write_failed with a 30 s Retry-After for a full disk and a read-only database", async () => {
    const app = await build();
    for (const url of ["/full", "/readonly", "/child-full"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(503);
      expect(res.headers["retry-after"]).toBe("30");
      expect(res.json()).toEqual({ error: "database cannot write", code: "database_write_failed" });
    }
    await app.close();
  });

  it("keeps database_unavailable for an outage, also for too many connections", async () => {
    const app = await build();
    for (const url of ["/down", "/toomany"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(503);
      expect(res.headers["retry-after"]).toBe("5");
      expect(res.json().code).toBe("database_unavailable");
    }
    await app.close();
  });
});
