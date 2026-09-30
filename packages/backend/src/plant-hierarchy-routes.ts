import type { FastifyInstance } from "fastify";
import { requireRole } from "./auth-plugin.js";
import { recordAuditEvent } from "./audit-repository.js";
import { isForeignKeyViolation, isUniqueViolation } from "./machines-repository.js";
import {
  createHierarchyNode,
  deleteHierarchyNode,
  getPlantHierarchy,
  updateHierarchyNode,
  type HierarchyLevel,
} from "./plant-hierarchy-repository.js";

/**
 * GET /api/plant-hierarchy — a teljes fa (telephelyek, részlegek, sorok,
 * darabszámokkal), minden bejelentkezett felhasználónak.
 *
 * POST/PATCH/DELETE /api/sites|areas|lines[/:id] — admin/manager, auditálva
 * (site_created, area_updated, line_deleted, …). A név kis/nagybetűtől
 * függetlenül egyedi a szülőn belül → 409. Nem üres elem nem törölhető → 409.
 */

const LEVELS: { level: HierarchyLevel; path: string; parentField: "siteId" | "areaId" | null; parentLabel: string }[] = [
  { level: "site", path: "/api/sites", parentField: null, parentLabel: "" },
  { level: "area", path: "/api/areas", parentField: "siteId", parentLabel: "site" },
  { level: "line", path: "/api/lines", parentField: "areaId", parentLabel: "area" },
];

const CHILD_LABEL: Record<HierarchyLevel, string> = {
  site: "it still has areas",
  area: "it still has lines or machines",
  line: "it still has machines",
};

function parseName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= 1 && t.length <= 100 ? t : null;
}

export default async function plantHierarchyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/plant-hierarchy", async () => getPlantHierarchy());

  for (const { level, path, parentField, parentLabel } of LEVELS) {
    app.post<{ Body: Record<string, unknown> }>(path, { preHandler: requireRole("admin", "manager") }, async (request, reply) => {
      const name = parseName(request.body?.name);
      if (!name) {
        reply.code(400);
        return { error: "name must be 1–100 characters", field: "name" };
      }
      let parentId: string | null = null;
      if (parentField) {
        const p = request.body?.[parentField];
        if (typeof p !== "string" || p === "") {
          reply.code(400);
          return { error: `${parentField} is required`, field: parentField };
        }
        parentId = p;
      }
      try {
        const node = await createHierarchyNode(level, name, parentId);
        await recordAuditEvent({
          actorId: request.user!.id,
          action: `${level}_created`,
          target: node.id,
          details: { name, parentId },
          ipAddress: request.ip,
        });
        reply.code(201);
        return node;
      } catch (err) {
        if (isUniqueViolation(err)) {
          reply.code(409);
          return { error: `"${name}" already exists here`, field: "name" };
        }
        if (isForeignKeyViolation(err)) {
          reply.code(400);
          return { error: `unknown ${parentLabel}`, field: parentField };
        }
        throw err;
      }
    });

    app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
      `${path}/:id`,
      { preHandler: requireRole("admin", "manager") },
      async (request, reply) => {
        const body = request.body ?? {};
        const changes: { name?: string; parentId?: string } = {};
        if ("name" in body) {
          const name = parseName(body.name);
          if (!name) {
            reply.code(400);
            return { error: "name must be 1–100 characters", field: "name" };
          }
          changes.name = name;
        }
        if (parentField && parentField in body) {
          const p = body[parentField];
          if (typeof p !== "string" || p === "") {
            reply.code(400);
            return { error: `${parentField} must be a non-empty id`, field: parentField };
          }
          changes.parentId = p;
        }
        if (changes.name === undefined && changes.parentId === undefined) {
          reply.code(400);
          return { error: "no fields to update" };
        }
        try {
          const result = await updateHierarchyNode(level, request.params.id, changes);
          if (!result) {
            reply.code(404);
            return { error: `unknown ${level}` };
          }
          await recordAuditEvent({
            actorId: request.user!.id,
            action: `${level}_updated`,
            target: request.params.id,
            details: { previous: result.previous, current: result.current },
            ipAddress: request.ip,
          });
          return result.current;
        } catch (err) {
          if (isUniqueViolation(err)) {
            reply.code(409);
            return { error: "this name already exists here", field: "name" };
          }
          if (isForeignKeyViolation(err)) {
            reply.code(400);
            return { error: `unknown ${parentLabel}`, field: parentField };
          }
          throw err;
        }
      },
    );

    app.delete<{ Params: { id: string } }>(`${path}/:id`, { preHandler: requireRole("admin", "manager") }, async (request, reply) => {
      try {
        const deleted = await deleteHierarchyNode(level, request.params.id);
        if (!deleted) {
          reply.code(404);
          return { error: `unknown ${level}` };
        }
        await recordAuditEvent({
          actorId: request.user!.id,
          action: `${level}_deleted`,
          target: deleted.id,
          details: { name: deleted.name, parentId: deleted.parentId },
          ipAddress: request.ip,
        });
        reply.code(204);
        return null;
      } catch (err) {
        if (isForeignKeyViolation(err)) {
          reply.code(409);
          return { error: `cannot delete this ${level}: ${CHILD_LABEL[level]}` };
        }
        throw err;
      }
    });
  }
}
