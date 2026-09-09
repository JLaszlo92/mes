import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { eventHub, MACHINE_EVENT } from "./hub.js";
import { stateStore } from "./state.js";
import { getShiftSummary } from "./shift-summary-repository.js";
import {
  listMachines,
  getMachine,
  createMachine,
  updateMachine,
  isUniqueViolation,
} from "./machines-repository.js";
import authPlugin, { requireRole } from "./auth-plugin.js";
import { findUserByEmail } from "./users-repository.js";
import { createSession, deleteSession } from "./sessions-repository.js";
import { verifyPassword } from "./password.js";
import { recordAuditEvent, listAuditLog } from "./audit-repository.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(websocket);
  await app.register(authPlugin);

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/machines", async () => stateStore.getAll());

  app.get<{ Params: { id: string } }>("/api/machines/:id", async (request, reply) => {
    const state = stateStore.get(request.params.id);
    if (!state) {
      reply.code(404);
      return { error: "unknown machine" };
    }
    return state;
  });

  app.get("/api/machine-registry", async () => listMachines());

  app.get<{ Params: { id: string } }>("/api/machine-registry/:id", async (request, reply) => {
    const machine = await getMachine(request.params.id);
    if (!machine) {
      reply.code(404);
      return { error: "unknown machine" };
    }
    return machine;
  });

  app.post<{ Body: { id: string; name: string; assetType?: string; location?: string } }>(
    "/api/machine-registry",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const { id, name, assetType, location } = request.body;
      if (!id || !name) {
        reply.code(400);
        return { error: "id and name are required" };
      }
      try {
        const machine = await createMachine({ id, name, assetType, location });
        await recordAuditEvent({
          actorId: request.user!.id,
          action: "machine_created",
          target: machine.id,
          details: { name, assetType, location },
          ipAddress: request.ip,
        });

        reply.code(201);
        return machine;
      } catch (err) {
        if (isUniqueViolation(err)) {
          reply.code(409);
          return { error: `machine with id "${id}" already exists` };
        }
        throw err;
      }
    },
  );

  app.post("/api/auth/logout", async (request, reply) => {
    const header = request.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      await deleteSession(header.slice("Bearer ".length));
      await recordAuditEvent({ actorId: request.user?.id, actorEmail: request.user?.email, action: "logout", ipAddress: request.ip });
    }
    reply.code(204);
    return null;
  });

  app.put<{
    Params: { id: string };
    Body: { name?: string; assetType?: string; location?: string; isActive?: boolean };
  }>(
    "/api/machine-registry/:id",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const machine = await updateMachine(request.params.id, request.body);
      if (!machine) {
        reply.code(404);
        return { error: "unknown machine" };
      }
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "machine_updated",
        target: machine.id,
        details: request.body,
        ipAddress: request.ip,
      });
      return machine;
    },
  );

  app.get("/api/audit-log", { preHandler: requireRole("admin") }, async () => listAuditLog());

  app.get<{ Querystring: { from: string; to: string } }>(
    "/api/shifts/summary",
    async (request, reply) => {
      const { from, to } = request.query;
      if (!from || !to) {
        reply.code(400);
        return { error: "from and to query params are required (ISO date strings)" };
      }
      return getShiftSummary(new Date(from), new Date(to));
    },
  );

  app.register(async (scoped) => {
    scoped.get("/ws", { websocket: true }, (socket, request) => {
      request.log.info("dashboard client connected");

      socket.send(JSON.stringify({ type: "snapshot", machines: stateStore.getAll() }));

      const onEvent = (event: unknown) => {
        socket.send(JSON.stringify({ type: "event", event }));
      };
      eventHub.on(MACHINE_EVENT, onEvent);

      socket.on("close", () => {
        eventHub.off(MACHINE_EVENT, onEvent);
        request.log.info("dashboard client disconnected");
      });
    });
  });

  app.post<{ Body: { email: string; password: string } }>("/api/auth/login", async (request, reply) => {
    const { email, password } = request.body;
    const user = await findUserByEmail(email);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      await recordAuditEvent({
        actorEmail: email,
        action: "login_failed",
        ipAddress: request.ip,
      });
      reply.code(401);
      return { error: "invalid email or password" };
    }
    const session = await createSession(user.id);
    await recordAuditEvent({
      actorId: user.id,
      actorEmail: user.email,
      action: "login_success",
      ipAddress: request.ip,
    });
    return { token: session.token, role: user.role, expiresAt: session.expiresAt };
  });

  return app;
}