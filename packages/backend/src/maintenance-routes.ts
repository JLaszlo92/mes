import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireRole } from "./auth-plugin.js";
import { recordAuditEvent } from "./audit-repository.js";
import { getMachine } from "./machines-repository.js";
import { resetSchedule } from "./preventive-maintenance-repository.js";
import {
  addLabor,
  addPart,
  createMaintenanceWorkOrder,
  getMaintenanceWorkOrder,
  isForeignKeyViolation,
  listAssignableUsers,
  listLabor,
  listMaintenanceWorkOrders,
  listParts,
  MaintenanceConflictError,
  patchMaintenanceWorkOrder,
} from "./maintenance-work-orders-repository.js";
import { parseLabor, parseMaintenanceCreate, parseMaintenancePatch, parsePart } from "./maintenance-input.js";

/**
 * Karbantartási munkarendelések.
 *
 *   GET   /api/maintenance-work-orders           (tervezett ablakkal, munkaóra- és alkatrész-összesítővel)
 *   GET   /api/maintenance-work-orders/:id
 *   POST  /api/maintenance-work-orders           maintenance/manager/admin
 *   PATCH /api/maintenance-work-orders/:id       maintenance/manager/admin — részleges, egy tranzakció
 *   PUT   /api/maintenance-work-orders/:id       ugyanaz (régi kliensek)
 *   GET/POST /api/maintenance-work-orders/:id/parts | /labor   — mostantól auditálva
 *   GET   /api/users/assignable                  akikhez munka rendelhető
 *
 * Deaktivált gépre nem lehet karbantartási ablakot tervezni (409) — ugyanaz a
 * szabály, mint a gyártási ütemezésnél. Hibajegyet nyitni rá viszont igen.
 */

function fail(reply: FastifyReply, code: number, error: string, field?: string) {
  reply.code(code);
  return field ? { error, field } : { error };
}

const MANAGE = { preHandler: requireRole("maintenance", "manager", "admin") };

async function rejectPlanningOnInactiveMachine(machineId: string, reply: FastifyReply) {
  const machine = await getMachine(machineId);
  if (!machine) return fail(reply, 400, "unknown machine", "machineId");
  if (!machine.isActive) return fail(reply, 409, "cannot plan maintenance on a deactivated machine", "plannedStart");
  return undefined;
}

export default async function maintenanceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/maintenance-work-orders", async () => listMaintenanceWorkOrders());

  app.get<{ Params: { id: string } }>("/api/maintenance-work-orders/:id", async (request, reply) => {
    const mwo = await getMaintenanceWorkOrder(request.params.id);
    if (!mwo) return fail(reply, 404, "unknown maintenance work order");
    return mwo;
  });

  app.get("/api/users/assignable", { preHandler: requireRole("maintenance", "supervisor", "manager", "admin") }, async () =>
    listAssignableUsers(),
  );

  app.post("/api/maintenance-work-orders", MANAGE, async (request, reply) => {
    const parsed = parseMaintenanceCreate(request.body);
    if (!parsed.ok) return fail(reply, 400, parsed.error, parsed.field);
    if (parsed.value.plannedStart) {
      const rejected = await rejectPlanningOnInactiveMachine(parsed.value.machineId, reply);
      if (rejected) return rejected;
    }
    try {
      const mwo = await createMaintenanceWorkOrder({ ...parsed.value, createdBy: request.user!.id });
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "maintenance_work_order_created",
        target: mwo.id,
        details: { ...parsed.value },
        ipAddress: request.ip,
      });
      reply.code(201);
      return mwo;
    } catch (err) {
      if (isForeignKeyViolation(err)) return fail(reply, 400, "unknown machine or user");
      throw err;
    }
  });

  const patchHandler = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const parsed = parseMaintenancePatch(request.body);
    if (!parsed.ok) return fail(reply, 400, parsed.error, parsed.field);
    const patch = parsed.value;
    if (patch.plannedStart || patch.machineId) {
      const existing = await getMaintenanceWorkOrder(request.params.id);
      if (!existing) return fail(reply, 404, "unknown maintenance work order");
      const willBePlanned = patch.plannedStart !== undefined ? patch.plannedStart !== null : existing.plannedStart !== null;
      if (willBePlanned) {
        const rejected = await rejectPlanningOnInactiveMachine(patch.machineId ?? existing.machineId, reply);
        if (rejected) return rejected;
      }
    }
    // Felelős kijelölése egy nyitott rendelést "assigned"-re léptet, ha a státuszt nem adták meg.
    if (patch.assignedTo && patch.status === undefined) {
      const existing = await getMaintenanceWorkOrder(request.params.id);
      if (existing?.status === "open") patch.status = "assigned";
    }
    try {
      const change = await patchMaintenanceWorkOrder(request.params.id, patch);
      if (!change) return fail(reply, 404, "unknown maintenance work order");
      if (Object.keys(change.changes).length > 0) {
        await recordAuditEvent({
          actorId: request.user!.id,
          action: "maintenance_work_order_updated",
          target: change.current.id,
          details: { ...patch, changes: change.changes },
          ipAddress: request.ip,
        });
      }
      if (change.changes.status && change.current.status === "closed" && change.current.sourceType === "preventive_schedule" && change.current.sourceId) {
        await resetSchedule(change.current.sourceId);
      }
      return change.current;
    } catch (err) {
      if (err instanceof MaintenanceConflictError) return fail(reply, 409, err.message, "machineId");
      if (isForeignKeyViolation(err)) return fail(reply, 400, "unknown machine or user");
      throw err;
    }
  };
  app.patch<{ Params: { id: string } }>("/api/maintenance-work-orders/:id", MANAGE, patchHandler);
  app.put<{ Params: { id: string } }>("/api/maintenance-work-orders/:id", MANAGE, patchHandler);

  app.get<{ Params: { id: string } }>("/api/maintenance-work-orders/:id/parts", async (request) => listParts(request.params.id));

  app.post<{ Params: { id: string } }>(
    "/api/maintenance-work-orders/:id/parts",
    { preHandler: requireRole("supervisor", "maintenance", "manager", "admin") },
    async (request, reply) => {
      const parsed = parsePart(request.body);
      if (!parsed.ok) return fail(reply, 400, parsed.error, parsed.field);
      try {
        await addPart(request.params.id, parsed.value.partName, parsed.value.quantity);
      } catch (err) {
        if (isForeignKeyViolation(err)) return fail(reply, 404, "unknown maintenance work order");
        throw err;
      }
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "maintenance_part_logged",
        target: request.params.id,
        details: parsed.value,
        ipAddress: request.ip,
      });
      reply.code(201);
      return { success: true };
    },
  );

  app.get<{ Params: { id: string } }>("/api/maintenance-work-orders/:id/labor", async (request) => listLabor(request.params.id));

  app.post<{ Params: { id: string } }>("/api/maintenance-work-orders/:id/labor", MANAGE, async (request, reply) => {
    const parsed = parseLabor(request.body);
    if (!parsed.ok) return fail(reply, 400, parsed.error, parsed.field);
    try {
      await addLabor(request.params.id, request.user!.id, parsed.value.hours, parsed.value.notes ?? undefined);
    } catch (err) {
      if (isForeignKeyViolation(err)) return fail(reply, 404, "unknown maintenance work order");
      throw err;
    }
    await recordAuditEvent({
      actorId: request.user!.id,
      action: "maintenance_labor_logged",
      target: request.params.id,
      details: parsed.value,
      ipAddress: request.ip,
    });
    reply.code(201);
    return { success: true };
  });
}
