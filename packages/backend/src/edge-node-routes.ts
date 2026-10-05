import type { FastifyInstance } from "fastify";
import { requireRole } from "./auth-plugin.js";
import { recordAuditEvent } from "./audit-repository.js";
import {
  getEdgeNodeSettings,
  InvalidTokenError,
  releaseSession,
  updateEdgeNodeSettings,
} from "./edge-nodes-repository.js";
import { validateSettingsPatch } from "./edge-node-settings.js";

/**
 * Extra edge node routes:
 *  - POST /api/edge-nodes/release: the agent gives its instance lease back on
 *    a clean shutdown (public, like claim/heartbeat: the token is the credential).
 *  - GET/PATCH /api/edge-nodes/:id/settings: per node settings (admin/manager).
 */
export function registerEdgeNodeExtras(app: FastifyInstance): void {
  app.post<{ Body: { token?: string; sessionId?: string } }>("/api/edge-nodes/release", async (request, reply) => {
    const { token, sessionId } = request.body ?? {};
    if (!token || !sessionId) {
      reply.code(400);
      return { error: "token and sessionId are required" };
    }
    try {
      return { success: true, released: (await releaseSession(token, sessionId)) === "released" };
    } catch (err) {
      if (err instanceof InvalidTokenError) {
        reply.code(401);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>(
    "/api/edge-nodes/:id/settings",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const settings = await getEdgeNodeSettings(request.params.id);
      if (!settings) {
        reply.code(404);
        return { error: "unknown edge node" };
      }
      return settings;
    },
  );

  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/api/edge-nodes/:id/settings",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const parsed = validateSettingsPatch(request.body);
      if (!parsed.ok) {
        reply.code(400);
        return { error: parsed.error };
      }
      const settings = await updateEdgeNodeSettings(request.params.id, parsed.patch);
      if (!settings) {
        reply.code(404);
        return { error: "unknown edge node" };
      }
      await recordAuditEvent({
        actorId: request.user!.id,
        actorEmail: request.user?.email,
        action: "edge_node_settings_updated",
        target: `${request.params.id} ${JSON.stringify(parsed.patch)}`,
        ipAddress: request.ip,
      });
      return settings;
    },
  );
}
