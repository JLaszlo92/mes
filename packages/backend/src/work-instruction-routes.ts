import type { FastifyInstance, FastifyReply } from "fastify";
import { requireRole } from "./auth-plugin.js";
import { recordAuditEvent } from "./audit-repository.js";
import { parsePaging } from "./paging.js";
import { MAX_PDF_BYTES, checkPdfUpload, parseWorkInstructionCreate, sanitizePdfFileName } from "./work-instruction-input.js";
import {
  createNewVersion,
  getCurrentInstructionForPart,
  getInstructionFile,
  getInstructionFileSha,
  getInstructionForWorkOrder,
  instructionFileExists,
  isForeignKeyViolation,
  listCurrentInstructions,
  listVersionsForPart,
  listViews,
  recordView,
  storeInstructionFile,
} from "./work-instructions-repository.js";

/**
 * Munkautasítások.
 *
 *   GET  /api/work-instructions                      a jelenlegi verziók (táblázat)
 *   GET  /api/work-instructions/:partName            egy utasítás jelenlegi verziója
 *   GET  /api/work-instructions/:partName/versions   minden verziója
 *   POST /api/work-instructions                      admin/manager — új utasítás VAGY új verzió (szerkesztés)
 *   POST /api/work-instructions/files                admin/manager — PDF feltöltés (a törzs maga a fájl)
 *   GET  /api/work-instructions/files/:id            a PDF (bármely bejelentkezett szerepkör, a terminál is)
 *   GET  /api/work-orders/:id/work-instruction       a rendeléshez tartozó utasítás (a terminál ezt kéri)
 *   POST /api/work-instructions/view                 megtekintés naplózása
 *   GET  /api/work-instructions/views/log            admin/manager/supervisor
 *
 * Minden route hitelesített (auth-guard.ts); a PDF ezért nem nyitható meg
 * sima linkként — a felület tokennel kéri le és maga jeleníti meg.
 */

function fail(reply: FastifyReply, code: number, error: string, field?: string) {
  reply.code(code);
  return field ? { error, field } : { error };
}

export default async function workInstructionRoutes(app: FastifyInstance): Promise<void> {
  // Only inside this plugin: a PDF body arrives as a Buffer. The limit is
  // enforced while reading, so an oversized upload is cut off (413).
  app.addContentTypeParser("application/pdf", { parseAs: "buffer", bodyLimit: MAX_PDF_BYTES }, (_request, body, done) => {
    done(null, body);
  });

  app.get("/api/work-instructions", async () => listCurrentInstructions());

  app.post(
    "/api/work-instructions/files",
    { preHandler: requireRole("admin", "manager"), bodyLimit: MAX_PDF_BYTES },
    async (request, reply) => {
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
    },
  );

  app.get<{ Params: { id: string } }>("/api/work-instructions/files/:id", async (request, reply) => {
    const sha = await getInstructionFileSha(request.params.id);
    if (!sha) return fail(reply, 404, "unknown file");
    const etag = `"${sha}"`;
    // A stored file never changes (new content = new id), so the browser may keep it.
    reply.header("ETag", etag).header("Cache-Control", "private, max-age=3600");
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    const file = await getInstructionFile(request.params.id);
    if (!file) return fail(reply, 404, "unknown file");
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", "inline")
      .header("X-Content-Type-Options", "nosniff")
      // An uploaded document must not be able to run anything in our origin.
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .send(file.content);
  });

  app.get<{ Params: { id: string } }>("/api/work-orders/:id/work-instruction", async (request, reply) => {
    const instruction = await getInstructionForWorkOrder(request.params.id);
    if (instruction === undefined) return fail(reply, 404, "unknown work order");
    if (instruction === null) return fail(reply, 404, "no work instruction for this work order");
    return instruction;
  });

  app.get(
    "/api/work-instructions/views/log",
    { preHandler: requireRole("admin", "manager", "supervisor") },
    async (request, reply) => {
      const query = request.query as { limit?: string; partName?: string };
      const paging = parsePaging({ limit: query.limit ?? "100" });
      if (!paging.ok) return fail(reply, 400, paging.error, paging.field);
      return listViews(paging.value.limit, query.partName || undefined);
    },
  );

  // Fastify already decodes path parameters; the name is used as it arrives.
  app.get<{ Params: { partName: string } }>("/api/work-instructions/:partName", async (request, reply) => {
    const instruction = await getCurrentInstructionForPart(request.params.partName);
    if (!instruction) return fail(reply, 404, "no instructions for this part");
    return instruction;
  });

  app.get<{ Params: { partName: string } }>("/api/work-instructions/:partName/versions", async (request) =>
    listVersionsForPart(request.params.partName),
  );

  app.post("/api/work-instructions", { preHandler: requireRole("admin", "manager") }, async (request, reply) => {
    const parsed = parseWorkInstructionCreate(request.body);
    if (!parsed.ok) return fail(reply, 400, parsed.error, parsed.field);
    const input = parsed.value;
    if (input.pdfFileId && !(await instructionFileExists(input.pdfFileId))) {
      return fail(reply, 400, "the uploaded file was not found; upload it again", "pdfFileId");
    }
    const instruction = await createNewVersion({ ...input, createdBy: request.user!.id });
    await recordAuditEvent({
      actorId: request.user!.id,
      action: "work_instruction_versioned",
      target: instruction.id,
      details: {
        partName: instruction.partName,
        version: instruction.version,
        pdfFileId: instruction.pdfFileId,
        pdfFileName: instruction.pdfFileName,
        pdfUrl: instruction.pdfUrl,
      },
      ipAddress: request.ip,
    });
    reply.code(201);
    return instruction;
  });

  app.post("/api/work-instructions/view", async (request, reply) => {
    const body = (request.body ?? {}) as { workInstructionId?: unknown; workOrderId?: unknown };
    if (typeof body.workInstructionId !== "string" || body.workInstructionId === "") {
      return fail(reply, 400, "workInstructionId is required", "workInstructionId");
    }
    const workOrderId = typeof body.workOrderId === "string" && body.workOrderId !== "" ? body.workOrderId : null;
    try {
      await recordView(body.workInstructionId, workOrderId, request.user!.id);
    } catch (err) {
      if (isForeignKeyViolation(err)) return fail(reply, 404, "unknown work instruction or work order");
      throw err;
    }
    reply.code(201);
    return { success: true };
  });
}
