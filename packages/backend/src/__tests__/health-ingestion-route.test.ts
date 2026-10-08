import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { DATABASE_UNAVAILABLE_BODY, RETRY_AFTER_SECONDS } from "../database-unavailable.js";
import { INGESTION_FAILING_BODY, IngestionTracker } from "../ingestion-health.js";

// The same route logic as server.ts: this test pins the contract of GET /health?db=1.
const healthy = vi.fn();
const tracker = new IngestionTracker({ minFailures: 2, minDurationMs: 0, staleMs: 120_000 });

async function build() {
  const app = Fastify();
  app.get<{ Querystring: { db?: string } }>("/health", async (request, reply) => {
    if (request.query.db === undefined) return { status: "ok" };
    if (await healthy()) {
      if (!tracker.status().failing) return { status: "ok", database: "ok" };
      reply.code(503).header("Retry-After", String(RETRY_AFTER_SECONDS));
      return INGESTION_FAILING_BODY;
    }
    reply.code(503).header("Retry-After", String(RETRY_AFTER_SECONDS));
    return DATABASE_UNAVAILABLE_BODY;
  });
  await app.ready();
  return app;
}

describe("GET /health?db=1 with the ingestion state", () => {
  it("ok / ingestion failing / database down", async () => {
    const app = await build();
    healthy.mockResolvedValue(true);
    expect((await app.inject("/health?db=1")).json()).toEqual({ status: "ok", database: "ok" });

    tracker.recordFailure(new Error("x"));
    tracker.recordFailure(new Error("x"));
    const failing = await app.inject("/health?db=1");
    expect([failing.statusCode, failing.headers["retry-after"], failing.json().code]).toEqual([503, "5", "ingestion_failing"]);
    expect(JSON.stringify(failing.json())).not.toMatch(/53100|space|disk/i); // /health is public: no internals

    expect((await app.inject("/health")).json()).toEqual({ status: "ok" }); // liveness stays untouched

    healthy.mockResolvedValue(false);
    expect((await app.inject("/health?db=1")).json().code).toBe("database_unavailable");

    healthy.mockResolvedValue(true);
    tracker.recordSuccess();
    expect((await app.inject("/health?db=1")).statusCode).toBe(200);
  });
});
