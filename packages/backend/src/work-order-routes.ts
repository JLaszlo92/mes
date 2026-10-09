import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireRole } from "./auth-plugin.js";
import { recordAuditEvent } from "./audit-repository.js";
import { generateLotForWorkOrder } from "./lots-repository.js";
import {
  bulkWorkOrderStatus,
  createWorkOrder,
  getWorkOrder,
  isUniqueViolation,
  listWorkOrders,
  patchWorkOrder,
  type WorkOrderChange,
} from "./work-orders-repository.js";
import { getCurrentInstructionForPart } from "./work-instructions-repository.js";
import { parseWorkOrderBulk, parseWorkOrderCreate, parseWorkOrderPatch } from "./work-order-input.js";

/**
 * Gyártási munkarendelés törzsadat-végpontok.
 *
 *   GET   /api/work-orders            — az ütemezés összefoglalójával (gép, kezdés, vég)
 *   GET   /api/work-orders/:id
 *   POST  /api/work-orders            admin/manager
 *   PATCH /api/work-orders/:id        admin/manager: bármely mező; operator: csak status
 *   PUT   /api/work-orders/:id        ugyanaz (a terminál ezt hívja)
 *   POST  /api/work-orders/bulk       admin/manager — release | cancel
 *
 * Az ütemezés NEM itt változik, hanem a PUT/DELETE /api/work-orders/:id/schedule
 * végponton (server.ts) — egy tranzakció, üzleti szabályokkal.
 *
 * FIGYELEM: a work_order_updated audit `details.status` mezőjéből olvassa
 * a computeWorkOrderProgress a gyártás kezdetét ('in_progress'). Ezért a
 * details a patch mezőit legfelső szinten tartalmazza (mint eddig), a diff
 * pedig külön `changes` kulcs alatt van.
 */

function fail(reply: FastifyReply, code: number, error: string, field?: string) {
  reply.code(code);
  return field ? { error, field } : { error };
}

async function afterChange(request: FastifyRequest, change: WorkOrderChange, details: Record<string, unknown>) {
  if (Object.keys(change.changes).length === 0) return;
  await recordAuditEvent({
    actorId: request.user!.id,
    action: "work_order_updated",
    target: change.current.id,
    details: { ...details, changes: change.changes },
    ipAddress: request.ip,
  });
  if (change.changes.status && change.current.status === "completed") {
    await generateLotForWorkOrder(change.current.id);
  }
}

/** A kiválasztott munkautasításnak léteznie kell (elgépelt név ne maradjon csendben utasítás nélkül). */
async function unknownInstruction(name: string | null | undefined): Promise<boolean> {
  return typeof name === "string" && !(await getCurrentInstructionForPart(name));
}

export default async function workOrderRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/work-orders", async () => listWorkOrders());

  app.get<{ Params: { id: string } }>("/api/work-orders/:id", async (request, reply) => {
    const workOrder = await getWorkOrder(request.params.id);
    if (!workOrder) return fail(reply, 404, "unknown work order");
    return workOrder;
  });

  app.post("/api/work-orders", { preHandler: requireRole("admin", "manager") }, async (request, reply) => {
    const parsed = parseWorkOrderCreate(request.body);
    if (!parsed.ok) return fail(reply, 400, parsed.error, parsed.field);
    if (await unknownInstruction(parsed.value.workInstructionName)) {
      return fail(reply, 400, `there is no work instruction named "${parsed.value.workInstructionName}"`, "workInstructionName");
    }
    try {
      const workOrder = await createWorkOrder(parsed.value);
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "work_order_created",
        target: workOrder.id,
        details: { ...parsed.value },
        ipAddress: request.ip,
      });
      reply.code(201);
      return workOrder;
    } catch (err) {
      if (isUniqueViolation(err)) return fail(reply, 409, `work order "${parsed.value.orderNumber}" already exists`, "orderNumber");
      throw err;
    }
  });

  const patchHandler = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const parsed = parseWorkOrderPatch(request.body);
    if (!parsed.ok) return fail(reply, 400, parsed.error, parsed.field);
    // Az operátor a terminálról csak indítani/lezárni tud — törzsadatot nem módosíthat.
    if (request.user!.role === "operator" && Object.keys(parsed.value).some((k) => k !== "status")) {
      return fail(reply, 403, "operators can only change the status of a work order");
    }
    if (await unknownInstruction(parsed.value.workInstructionName)) {
      return fail(reply, 400, `there is no work instruction named "${parsed.value.workInstructionName}"`, "workInstructionName");
    }
    const change = await patchWorkOrder(request.params.id, parsed.value);
    if (!change) return fail(reply, 404, "unknown work order");
    await afterChange(request, change, { ...parsed.value });
    return change.current;
  };
  const roles = { preHandler: requireRole("admin", "manager", "operator") };
  app.patch<{ Params: { id: string } }>("/api/work-orders/:id", roles, patchHandler);
  app.put<{ Params: { id: string } }>("/api/work-orders/:id", roles, patchHandler);

  app.post("/api/work-orders/bulk", { preHandler: requireRole("admin", "manager") }, async (request, reply) => {
    const parsed = parseWorkOrderBulk(request.body);
    if (!parsed.ok) return fail(reply, 400, parsed.error, parsed.field);
    const result = await bulkWorkOrderStatus(parsed.value);
    for (const change of result.changed) {
      await afterChange(request, change, { status: change.current.status, bulk: parsed.value.action });
    }
    return {
      updated: result.changed.length,
      skipped: result.skipped,
      unknown: result.unknown,
      workOrders: result.changed.map((c) => c.current),
    };
  });
}
