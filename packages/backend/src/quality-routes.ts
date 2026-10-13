import type { FastifyInstance, FastifyReply } from "fastify";
import { recordAuditEvent } from "./audit-repository.js";
import { parsePaging } from "./paging.js";
import { CHECK_KINDS, parsePlanInput, type CheckKind } from "./quality-input.js";
import {
  archivePlan,
  createPlanVersion,
  getCheck,
  getCheckDetail,
  getPlan,
  isForeignKeyViolation,
  listChecksForWorkOrder,
  listChecksPage,
  listCurrentPlans,
  listPlanVersions,
  QualityError,
  releaseCheck,
  type CheckStatus,
} from "./quality-repository.js";
import { checkPdfUpload, MAX_PDF_BYTES, sanitizePdfFileName } from "./work-instruction-input.js";
import { storeInstructionFile } from "./work-instructions-repository.js";
import { spcSeries, spcSummary, type SpcFilter } from "./spc-repository.js";

/**
 * Minőségellenőrzés a dashboardon.
 *
 *   GET  /api/quality-plans                       a part-ok aktuális tervei
 *   GET  /api/quality-plans/by-id/:id             egy verzió a jellemzőkkel
 *   GET  /api/quality-plans/:partName/versions    verziótörténet
 *   POST /api/quality-plans                       új terv / új verzió (quality.plans)
 *   POST /api/quality-plans/:partName/archive     a part-nak nincs többé terve (quality.plans)
 *   POST /api/quality-plans/files                 PDF a jellemzőhöz (quality.plans)
 *   GET  /api/quality-checks                      lapozott lista (szűrők: q, status, kind, workOrderId, machineIds)
 *   GET  /api/quality-checks/:id                  minden mérés, minden próbálkozás
 *   POST /api/quality-checks/:id/release          feloldás indoklással (quality.release)
 *   GET  /api/work-orders/:id/quality-checks      egy rendelés összes ellenőrzése részletesen
 *   GET  /api/quality/spc                         képesség jellemzőnként (from, to, machineIds, kinds, attempts)
 *   GET  /api/quality/spc/series                  I-MR kártya egy jellemzőre (+ partName, name)
 *
 * A mérés maga a terminálon történik (terminal-routes.ts).
 */

const STATUSES: readonly (CheckStatus | "active")[] = ["active", "open", "failed", "passed", "released", "skipped", "missed"];

function fail(reply: FastifyReply, code: number, error: string, field?: string) {
  reply.code(code);
  return field ? { error, field } : { error };
}

export default async function qualityRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser("application/pdf", { parseAs: "buffer", bodyLimit: MAX_PDF_BYTES }, (_request, body, done) => {
    done(null, body);
  });

  app.get("/api/quality-plans", async () => listCurrentPlans());

  app.get<{ Params: { id: string } }>("/api/quality-plans/by-id/:id", async (request, reply) => {
    const plan = await getPlan(request.params.id);
    return plan ?? fail(reply, 404, "unknown quality plan");
  });

  app.get<{ Params: { partName: string } }>("/api/quality-plans/:partName/versions", async (request) => listPlanVersions(request.params.partName));

  app.post("/api/quality-plans", async (request, reply) => {
    const parsed = parsePlanInput(request.body);
    if (!parsed.ok) return fail(reply, 400, parsed.error, parsed.field);
    try {
      const plan = await createPlanVersion(parsed.value, request.user!.id);
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "quality_plan_saved",
        target: plan.id,
        details: {
          partName: plan.partName,
          version: plan.version,
          firstPiece: plan.firstPiece,
          lastPiece: plan.lastPiece,
          spot: plan.spot,
          characteristics: plan.characteristics.map((c) => ({ name: c.name, kind: c.kind, nominal: c.nominal, lower: c.lowerLimit, upper: c.upperLimit, unit: c.unit })),
        },
        ipAddress: request.ip,
      });
      reply.code(201);
      return plan;
    } catch (err) {
      if (isForeignKeyViolation(err)) return fail(reply, 400, "a PDF of a measurement is not stored on the server; upload it again", "characteristics");
      throw err;
    }
  });

  app.post<{ Params: { partName: string } }>("/api/quality-plans/:partName/archive", async (request, reply) => {
    if (!(await archivePlan(request.params.partName))) return fail(reply, 404, "this part has no active quality plan");
    await recordAuditEvent({ actorId: request.user!.id, action: "quality_plan_archived", target: request.params.partName, ipAddress: request.ip });
    return { success: true };
  });

  app.post("/api/quality-plans/files", { bodyLimit: MAX_PDF_BYTES }, async (request, reply) => {
    const checked = checkPdfUpload(request.body);
    if (!checked.ok) return fail(reply, 400, checked.error, checked.field);
    let rawName = "";
    try {
      const header = request.headers["x-file-name"];
      rawName = decodeURIComponent(Array.isArray(header) ? (header[0] ?? "") : (header ?? ""));
    } catch {
      // A malformed header only costs the display name.
    }
    const stored = await storeInstructionFile(checked.value, request.user!.id);
    reply.code(201);
    return { id: stored.id, sizeBytes: stored.sizeBytes, fileName: sanitizePdfFileName(rawName) };
  });

  app.get<{ Querystring: { q?: string; status?: string; kind?: string; workOrderId?: string; machineIds?: string; limit?: string; offset?: string } }>(
    "/api/quality-checks",
    async (request, reply) => {
      const paging = parsePaging(request.query);
      if (!paging.ok) return fail(reply, 400, paging.error, paging.field);
      const { q, status, kind, workOrderId, machineIds } = request.query;
      if (status && !STATUSES.includes(status as CheckStatus)) return fail(reply, 400, "unknown status", "status");
      if (kind && !CHECK_KINDS.includes(kind as CheckKind)) return fail(reply, 400, "unknown kind", "kind");
      return listChecksPage({
        q: q?.trim() || undefined,
        status: (status || undefined) as CheckStatus | "active" | undefined,
        kind: (kind || undefined) as CheckKind | undefined,
        workOrderId: workOrderId || undefined,
        machineIds: machineIds ? machineIds.split(",").filter(Boolean).slice(0, 1000) : undefined,
        ...paging.value,
      });
    },
  );

  app.get<{ Params: { id: string } }>("/api/quality-checks/:id", async (request, reply) => {
    const detail = await getCheckDetail(request.params.id);
    return detail ?? fail(reply, 404, "unknown quality check");
  });

  app.post<{ Params: { id: string } }>("/api/quality-checks/:id/release", async (request, reply) => {
    const reason = (request.body as { reason?: unknown } | undefined)?.reason;
    if (typeof reason !== "string" || reason.trim().length < 3) return fail(reply, 400, "give the reason of the release", "reason");
    const before = await getCheck(request.params.id);
    try {
      const user = request.user!;
      const released = await releaseCheck(request.params.id, reason.trim().slice(0, 500), { id: user.id, name: user.name });
      await recordAuditEvent({
        actorId: user.id,
        action: "quality_check_released",
        target: released.id,
        details: { workOrderId: released.workOrderId, orderNumber: released.orderNumber, kind: released.kind, from: before?.status, reason: reason.trim() },
        ipAddress: request.ip,
      });
      return released;
    } catch (err) {
      if (err instanceof QualityError) return fail(reply, err.httpStatus, err.message);
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/api/work-orders/:id/quality-checks", async (request) => listChecksForWorkOrder(request.params.id));

  type SpcQuery = { from?: string; to?: string; machineIds?: string; kinds?: string; attempts?: string; partName?: string; name?: string };
  function spcFilter(q: SpcQuery): { ok: true; value: SpcFilter } | { ok: false; error: string; field: string } {
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 24 * 3600_000);
    if (isNaN(from.getTime())) return { ok: false, field: "from", error: "from is not a date" };
    const to = q.to ? new Date(q.to) : undefined;
    if (to && isNaN(to.getTime())) return { ok: false, field: "to", error: "to is not a date" };
    const kinds = q.kinds ? q.kinds.split(",").filter(Boolean) : undefined;
    if (kinds?.some((k) => !CHECK_KINDS.includes(k as CheckKind))) return { ok: false, field: "kinds", error: "unknown check kind" };
    if (q.attempts && q.attempts !== "all" && q.attempts !== "first") return { ok: false, field: "attempts", error: "attempts is all or first" };
    return {
      ok: true,
      value: {
        from,
        to,
        machineIds: q.machineIds ? q.machineIds.split(",").filter(Boolean).slice(0, 1000) : undefined,
        kinds: kinds as CheckKind[] | undefined,
        attempts: q.attempts === "first" ? "first" : "all",
      },
    };
  }

  app.get<{ Querystring: SpcQuery }>("/api/quality/spc", async (request, reply) => {
    const f = spcFilter(request.query);
    if (!f.ok) return fail(reply, 400, f.error, f.field);
    return spcSummary(f.value);
  });

  app.get<{ Querystring: SpcQuery }>("/api/quality/spc/series", async (request, reply) => {
    const f = spcFilter(request.query);
    if (!f.ok) return fail(reply, 400, f.error, f.field);
    const { partName, name } = request.query;
    if (!partName || !name) return fail(reply, 400, "partName and name are required", "partName");
    const series = await spcSeries(f.value, partName, name);
    return series ?? fail(reply, 404, "no measurements of this characteristic in the period");
  });
}
