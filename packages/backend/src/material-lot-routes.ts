import type { FastifyInstance, FastifyReply } from "fastify";
import { recordAuditEvent } from "./audit-repository.js";
import { getLotForWorkOrder, listLots } from "./lots-repository.js";
import { localToday, parseMaterialLotCreate, parseMaterialLotPatch } from "./material-lot-input.js";
import {
  createMaterialLot,
  deleteMaterialLotIfUnused,
  getMaterialLot,
  isForeignKeyViolation,
  isUniqueViolation,
  listConsumptionForWorkOrder,
  listMaterialLotUsage,
  listMaterialLots,
  recordConsumption,
  removeConsumption,
  updateMaterialLot,
} from "./material-lots-repository.js";

/**
 * Nyomonkövetés: alapanyag-tételek, felhasználásuk a work ordereken, és a
 * lezáráskor keletkező késztermék-tételek (lots).
 *
 *   GET    /api/lots                                              késztermék-tételek, anyaggal
 *   GET    /api/work-orders/:id/lot
 *   GET    /api/material-lots                                     használati számokkal
 *   GET    /api/material-lots/:id
 *   GET    /api/material-lots/:id/usage                           hol használták (visszakeresés)
 *   POST   /api/material-lots                                     bármely bejelentkezett szerepkör (áruátvétel)
 *   PATCH  /api/material-lots/:id                                 admin/manager
 *   DELETE /api/material-lots/:id                                 admin/manager, csak ha nincs használva
 *   GET    /api/work-orders/:id/material-consumption
 *   POST   /api/work-orders/:id/material-consumption              bármely bejelentkezett szerepkör
 *   DELETE /api/work-orders/:id/material-consumption/:materialLotId   admin/manager
 */

function fail(reply: FastifyReply, code: number, error: string, field?: string) {
  reply.code(code);
  return field ? { error, field } : { error };
}

const DUPLICATE = "a material lot with this material and lot number already exists";

export default async function materialLotRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/lots", async () => listLots());

  app.get<{ Params: { id: string } }>("/api/work-orders/:id/lot", async (request, reply) => {
    const lot = await getLotForWorkOrder(request.params.id);
    if (!lot) return fail(reply, 404, "no lot generated yet for this work order");
    return lot;
  });

  app.get("/api/material-lots", async () => listMaterialLots());

  app.get<{ Params: { id: string } }>("/api/material-lots/:id", async (request, reply) => {
    const lot = await getMaterialLot(request.params.id);
    if (!lot) return fail(reply, 404, "unknown material lot");
    return lot;
  });

  app.get<{ Params: { id: string } }>("/api/material-lots/:id/usage", async (request, reply) => {
    if (!(await getMaterialLot(request.params.id))) return fail(reply, 404, "unknown material lot");
    return listMaterialLotUsage(request.params.id);
  });

  app.post("/api/material-lots", async (request, reply) => {
    const parsed = parseMaterialLotCreate(request.body, localToday());
    if (!parsed.ok) return fail(reply, 400, parsed.error, parsed.field);
    try {
      const lot = await createMaterialLot(parsed.value);
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "material_lot_created",
        target: lot.id,
        details: { ...parsed.value },
        ipAddress: request.ip,
      });
      reply.code(201);
      return lot;
    } catch (err) {
      if (isUniqueViolation(err)) return fail(reply, 409, DUPLICATE, "lotNumber");
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/material-lots/:id", async (request, reply) => {
    const parsed = parseMaterialLotPatch(request.body, localToday());
    if (!parsed.ok) return fail(reply, 400, parsed.error, parsed.field);
    try {
      const change = await updateMaterialLot(request.params.id, parsed.value);
      if (!change) return fail(reply, 404, "unknown material lot");
      if (Object.keys(change.changes).length > 0) {
        await recordAuditEvent({
          actorId: request.user!.id,
          action: "material_lot_updated",
          target: request.params.id,
          details: { changes: change.changes },
          ipAddress: request.ip,
        });
      }
      return change.current;
    } catch (err) {
      if (isUniqueViolation(err)) return fail(reply, 409, DUPLICATE, "lotNumber");
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>("/api/material-lots/:id", async (request, reply) => {
    const result = await deleteMaterialLotIfUnused(request.params.id);
    if (result === "not_found") return fail(reply, 404, "unknown material lot");
    if ("inUse" in result) {
      return fail(reply, 409, `this material lot is recorded on ${result.inUse} work order(s); remove it there first`);
    }
    await recordAuditEvent({
      actorId: request.user!.id,
      action: "material_lot_deleted",
      target: request.params.id,
      details: { materialName: result.deleted.materialName, lotNumber: result.deleted.lotNumber },
      ipAddress: request.ip,
    });
    return { success: true };
  });

  app.get<{ Params: { id: string } }>("/api/work-orders/:id/material-consumption", async (request) =>
    listConsumptionForWorkOrder(request.params.id),
  );

  app.post<{ Params: { id: string } }>("/api/work-orders/:id/material-consumption", async (request, reply) => {
    const body = (request.body ?? {}) as { materialLotId?: unknown };
    if (typeof body.materialLotId !== "string" || body.materialLotId === "") {
      return fail(reply, 400, "materialLotId is required", "materialLotId");
    }
    try {
      await recordConsumption(request.params.id, body.materialLotId, request.user!.id);
    } catch (err) {
      if (isForeignKeyViolation(err)) return fail(reply, 404, "unknown work order or material lot");
      throw err;
    }
    await recordAuditEvent({
      actorId: request.user!.id,
      action: "material_consumption_recorded",
      target: request.params.id,
      details: { materialLotId: body.materialLotId },
      ipAddress: request.ip,
    });
    reply.code(201);
    return { success: true };
  });

  app.delete<{ Params: { id: string; materialLotId: string } }>(
    "/api/work-orders/:id/material-consumption/:materialLotId",
    async (request, reply) => {
      const removed = await removeConsumption(request.params.id, request.params.materialLotId);
      if (!removed) return fail(reply, 404, "this material lot is not recorded on this work order");
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "material_consumption_removed",
        target: request.params.id,
        details: { materialLotId: request.params.materialLotId },
        ipAddress: request.ip,
      });
      return { success: true };
    },
  );
}
