import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireRole } from "./auth-plugin.js";
import { recordAuditEvent } from "./audit-repository.js";
import {
  createMachine,
  getMachine,
  isForeignKeyViolation,
  isUniqueViolation,
  listMachines,
  MachineInputError,
  patchMachine,
  patchMachines,
  UnknownMachinesError,
  type MachineChange,
} from "./machines-repository.js";
import { parseMachineBulk, parseMachineCreate, parseMachinePatch, type MachinePatch } from "./machine-input.js";

/**
 * Gép-törzsadat végpontok.
 *
 *   GET   /api/machine-registry?active=true|false   (paraméter nélkül: mind)
 *   GET   /api/machine-registry/:id
 *   POST  /api/machine-registry                      admin/manager
 *   PATCH /api/machine-registry/:id                  admin/manager — részleges, egy tranzakció
 *   PUT   /api/machine-registry/:id                  ugyanaz (régi kliensek/integrációk)
 *   POST  /api/machine-registry/bulk                 admin/manager — activate | deactivate | move
 *
 * Hibás bemenet: 400 { error, field } — a szerkesztő a mező mellett jeleníti meg.
 * A PUT /:id/scheduling és /:id/micro-stop-threshold régi végpontok a
 * server.ts-ben maradnak; az új felület a PATCH-et használja.
 */

function fail(reply: FastifyReply, code: number, error: string, field?: string) {
  reply.code(code);
  return field ? { error, field } : { error };
}

/** Az adatbázis-szintű hibák közös fordítása 4xx-re. */
function translateError(reply: FastifyReply, err: unknown) {
  if (err instanceof MachineInputError) return fail(reply, 400, err.message, err.field);
  if (err instanceof UnknownMachinesError) return fail(reply, 404, err.message, "ids");
  if (isForeignKeyViolation(err)) return fail(reply, 400, "unknown area, line, shift pattern or calendar");
  return undefined;
}

async function auditChange(request: FastifyRequest, change: MachineChange, extra: Record<string, unknown> = {}) {
  if (Object.keys(change.changes).length === 0) return;
  await recordAuditEvent({
    actorId: request.user!.id,
    action: "machine_updated",
    target: change.current.id,
    details: { ...extra, changes: change.changes },
    ipAddress: request.ip,
  });
}

export default async function machineRegistryRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { active?: string } }>("/api/machine-registry", async (request, reply) => {
    const { active } = request.query;
    if (active !== undefined && active !== "true" && active !== "false") {
      return fail(reply, 400, "active must be true or false", "active");
    }
    return listMachines({ active: active === undefined ? undefined : active === "true" });
  });

  app.get<{ Params: { id: string } }>("/api/machine-registry/:id", async (request, reply) => {
    const machine = await getMachine(request.params.id);
    if (!machine) return fail(reply, 404, "unknown machine");
    return machine;
  });

  app.post("/api/machine-registry", { preHandler: requireRole("admin", "manager") }, async (request, reply) => {
    const parsed = parseMachineCreate(request.body);
    if (!parsed.ok) return fail(reply, 400, parsed.error, parsed.field);
    try {
      const machine = await createMachine(parsed.value);
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "machine_created",
        target: machine.id,
        details: { ...parsed.value },
        ipAddress: request.ip,
      });
      reply.code(201);
      return machine;
    } catch (err) {
      if (isUniqueViolation(err)) return fail(reply, 409, `machine with id "${parsed.value.id}" already exists`, "id");
      const translated = translateError(reply, err);
      if (translated) return translated;
      throw err;
    }
  });

  const patchHandler = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const parsed = parseMachinePatch(request.body);
    if (!parsed.ok) return fail(reply, 400, parsed.error, parsed.field);
    try {
      const change = await patchMachine(request.params.id, parsed.value);
      if (!change) return fail(reply, 404, "unknown machine");
      await auditChange(request, change);
      return change.current;
    } catch (err) {
      const translated = translateError(reply, err);
      if (translated) return translated;
      throw err;
    }
  };
  app.patch<{ Params: { id: string } }>("/api/machine-registry/:id", { preHandler: requireRole("admin", "manager") }, patchHandler);
  app.put<{ Params: { id: string } }>("/api/machine-registry/:id", { preHandler: requireRole("admin", "manager") }, patchHandler);

  app.post("/api/machine-registry/bulk", { preHandler: requireRole("admin", "manager") }, async (request, reply) => {
    const parsed = parseMachineBulk(request.body);
    if (!parsed.ok) return fail(reply, 400, parsed.error, parsed.field);
    const bulk = parsed.value;
    const patch: MachinePatch =
      bulk.action === "move"
        ? { areaId: bulk.areaId, lineId: bulk.lineId }
        : { isActive: bulk.action === "activate" };
    try {
      const changes = await patchMachines(bulk.ids, patch);
      // Gépenként külön auditbejegyzés: a gép előzményeiben is látsszon.
      for (const change of changes) await auditChange(request, change, { bulk: bulk.action });
      return { updated: changes.filter((c) => Object.keys(c.changes).length > 0).length, machines: changes.map((c) => c.current) };
    } catch (err) {
      const translated = translateError(reply, err);
      if (translated) return translated;
      throw err;
    }
  });
}
