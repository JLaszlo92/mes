import type { FastifyInstance, FastifyReply } from "fastify";
import { recordAuditEvent } from "./audit-repository.js";
import { parsePaging } from "./paging.js";
import {
  createScrapReason,
  deleteScrapReason,
  isForeignKeyViolation,
  isUniqueViolation,
  listBookingsPage,
  listScrapModes,
  listScrapReasons,
  scrapAnalysis,
  SCRAP_MODES,
  setScrapMode,
  updateScrapReason,
  type ScrapFilter,
  type ScrapMode,
} from "./scrap-repository.js";

/**
 * Selejtokok és a selejt visszakövetése a dashboardon.
 *
 *   GET    /api/scrap-reasons                 mind (globális és gépenkénti)
 *   POST   /api/scrap-reasons                 admin.machines
 *   PATCH  /api/scrap-reasons/:id             név, aktív (admin.machines)
 *   DELETE /api/scrap-reasons/:id             admin.machines (a lejelentések megőrzik a nevet)
 *   GET    /api/scrap-modes                   gépenként: reclassify | additional
 *   PUT    /api/machine-registry/:id/scrap-mode   admin.machines
 *   GET    /api/scrap/analysis                ok és gép szerint (from, to, machineIds, workOrderId)
 *   GET    /api/scrap-bookings                a terminálon lejelentett selejt, lapozva (+ q)
 *
 * A lejelentés a terminálon történik (terminal-routes.ts).
 */

function fail(reply: FastifyReply, code: number, error: string, field?: string) {
  reply.code(code);
  return field ? { error, field } : { error };
}

type FilterQuery = { from?: string; to?: string; machineIds?: string; workOrderId?: string; q?: string; limit?: string; offset?: string };

function parseFilter(q: FilterQuery): { ok: true; value: ScrapFilter } | { ok: false; error: string; field: string } {
  const from = q.from ? new Date(q.from) : new Date(Date.now() - 7 * 24 * 3600_000);
  if (isNaN(from.getTime())) return { ok: false, field: "from", error: "from is not a date" };
  const to = q.to ? new Date(q.to) : undefined;
  if (to && isNaN(to.getTime())) return { ok: false, field: "to", error: "to is not a date" };
  return {
    ok: true,
    value: { from, to, machineIds: q.machineIds ? q.machineIds.split(",").filter(Boolean).slice(0, 1000) : undefined, workOrderId: q.workOrderId || undefined },
  };
}

const CODE_RE = /^[A-Za-z0-9_.-]{1,40}$/;

export default async function scrapRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/scrap-reasons", async () => listScrapReasons());

  app.post<{ Body: { machineId?: unknown; code?: unknown; name?: unknown } }>("/api/scrap-reasons", async (request, reply) => {
    const { machineId, code, name } = request.body ?? {};
    if (typeof code !== "string" || !CODE_RE.test(code.trim())) return fail(reply, 400, "the code is 1–40 letters, digits, _ . -", "code");
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120) return fail(reply, 400, "the name is required (at most 120 characters)", "name");
    if (machineId !== undefined && machineId !== null && machineId !== "" && typeof machineId !== "string") return fail(reply, 400, "unknown machine", "machineId");
    try {
      const reason = await createScrapReason({ machineId: (machineId as string) || null, code: code.trim(), name: name.trim() });
      await recordAuditEvent({ actorId: request.user!.id, action: "scrap_reason_created", target: reason.id, details: { ...reason }, ipAddress: request.ip });
      reply.code(201);
      return reason;
    } catch (err) {
      if (isUniqueViolation(err)) return fail(reply, 409, "this code already exists in this scope", "code");
      if (isForeignKeyViolation(err)) return fail(reply, 404, "unknown machine", "machineId");
      throw err;
    }
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown; isActive?: unknown } }>("/api/scrap-reasons/:id", async (request, reply) => {
    const { name, isActive } = request.body ?? {};
    if (name !== undefined && (typeof name !== "string" || !name.trim() || name.trim().length > 120)) return fail(reply, 400, "the name is required (at most 120 characters)", "name");
    if (isActive !== undefined && typeof isActive !== "boolean") return fail(reply, 400, "isActive must be true or false", "isActive");
    const updated = await updateScrapReason(request.params.id, { name: typeof name === "string" ? name.trim() : undefined, isActive: isActive as boolean | undefined });
    if (!updated) return fail(reply, 404, "unknown scrap reason");
    await recordAuditEvent({
      actorId: request.user!.id,
      action: "scrap_reason_updated",
      target: request.params.id,
      details: { code: updated.after.code, changes: { name: { from: updated.before.name, to: updated.after.name }, isActive: { from: updated.before.isActive, to: updated.after.isActive } } },
      ipAddress: request.ip,
    });
    return updated.after;
  });

  app.delete<{ Params: { id: string } }>("/api/scrap-reasons/:id", async (request, reply) => {
    if (!(await deleteScrapReason(request.params.id))) return fail(reply, 404, "unknown scrap reason");
    await recordAuditEvent({ actorId: request.user!.id, action: "scrap_reason_deleted", target: request.params.id, ipAddress: request.ip });
    reply.code(204);
    return null;
  });

  app.get("/api/scrap-modes", async () => listScrapModes());

  app.put<{ Params: { id: string }; Body: { mode?: unknown } }>("/api/machine-registry/:id/scrap-mode", async (request, reply) => {
    const mode = request.body?.mode;
    if (typeof mode !== "string" || !SCRAP_MODES.includes(mode as ScrapMode)) return fail(reply, 400, "mode is reclassify or additional", "mode");
    const changed = await setScrapMode(request.params.id, mode as ScrapMode);
    if (!changed) return fail(reply, 404, "unknown machine");
    await recordAuditEvent({ actorId: request.user!.id, action: "machine_scrap_mode_updated", target: request.params.id, details: { from: changed.from, to: mode }, ipAddress: request.ip });
    return { machineId: request.params.id, mode };
  });

  app.get<{ Querystring: FilterQuery }>("/api/scrap/analysis", async (request, reply) => {
    const f = parseFilter(request.query);
    if (!f.ok) return fail(reply, 400, f.error, f.field);
    return scrapAnalysis(f.value);
  });

  app.get<{ Querystring: FilterQuery }>("/api/scrap-bookings", async (request, reply) => {
    const f = parseFilter(request.query);
    if (!f.ok) return fail(reply, 400, f.error, f.field);
    const paging = parsePaging(request.query);
    if (!paging.ok) return fail(reply, 400, paging.error, paging.field);
    return listBookingsPage({ ...f.value, q: request.query.q?.trim() || undefined, ...paging.value });
  });
}
