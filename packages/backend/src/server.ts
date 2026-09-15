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
import {
  listWorkOrders,
  getWorkOrder,
  createWorkOrder,
  updateWorkOrder,
  isUniqueViolation as isWorkOrderUniqueViolation,
} from "./work-orders-repository.js";
import {
  listAssignments,
  createAssignment,
  deleteAssignment,
  isForeignKeyViolation,
  isCheckViolation,
  listAssignmentsForMachine,
} from "./work-order-assignments-repository.js";
import {
  listTerminalUis,
  getTerminalUi,
  createTerminalUi,
  updateTerminalUi,
  deleteTerminalUi,
  isUniqueViolation as isTerminalUiUniqueViolation,
} from "./terminal-uis-repository.js";

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

  app.get("/api/work-orders", async () => listWorkOrders());

  app.get<{ Params: { id: string } }>("/api/work-orders/:id", async (request, reply) => {
    const workOrder = await getWorkOrder(request.params.id);
    if (!workOrder) {
      reply.code(404);
      return { error: "unknown work order" };
    }
    return workOrder;
  });

  app.post<{
    Body: {
      orderNumber: string;
      partName: string;
      quantity: number;
      expectedCycleTimeSeconds?: number;
      dueDate?: string;
      notes?: string;
    };
  }>("/api/work-orders", { preHandler: requireRole("admin", "manager") }, async (request, reply) => {
    const { orderNumber, partName, quantity } = request.body;
    if (!orderNumber || !partName || !quantity) {
      reply.code(400);
      return { error: "orderNumber, partName and quantity are required" };
    }
    try {
      const workOrder = await createWorkOrder(request.body);
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "work_order_created",
        target: workOrder.id,
        details: { orderNumber, partName, quantity },
        ipAddress: request.ip,
      });
      reply.code(201);
      return workOrder;
    } catch (err) {
      if (isWorkOrderUniqueViolation(err)) {
        reply.code(409);
        return { error: `work order with order number "${orderNumber}" already exists` };
      }
      throw err;
    }
  });

  app.put<{
    Params: { id: string };
    Body: {
      partName?: string;
      quantity?: number;
      expectedCycleTimeSeconds?: number;
      dueDate?: string;
      status?: "planned" | "released" | "in_progress" | "completed" | "cancelled";
      notes?: string;
    };
  }>("/api/work-orders/:id", { preHandler: requireRole("admin", "manager", "operator") }, async (request, reply) => {
    const workOrder = await updateWorkOrder(request.params.id, request.body);
    if (!workOrder) {
      reply.code(404);
      return { error: "unknown work order" };
    }
    await recordAuditEvent({
      actorId: request.user!.id,
      action: "work_order_updated",
      target: workOrder.id,
      details: request.body,
      ipAddress: request.ip,
    });
    return workOrder;
  });

  app.get<{ Querystring: { machineId?: string } }>("/api/work-order-assignments", async (request) => {
    if (request.query.machineId) return listAssignmentsForMachine(request.query.machineId);
    return listAssignments();
  });
  app.post<{
    Body: { workOrderId: string; machineId: string; plannedStart: string; plannedEnd: string };
  }>("/api/work-order-assignments", { preHandler: requireRole("admin", "manager") }, async (request, reply) => {
    const { workOrderId, machineId, plannedStart, plannedEnd } = request.body;
    if (!workOrderId || !machineId || !plannedStart || !plannedEnd) {
      reply.code(400);
      return { error: "workOrderId, machineId, plannedStart and plannedEnd are required" };
    }
    try {
      const assignment = await createAssignment(request.body);
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "work_order_assigned",
        target: assignment.id,
        details: { workOrderId, machineId, plannedStart, plannedEnd },
        ipAddress: request.ip,
      });
      reply.code(201);
      return assignment;
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        reply.code(404);
        return { error: "unknown work order or machine" };
      }
      if (isCheckViolation(err)) {
        reply.code(400);
        return { error: "plannedEnd must be after plannedStart" };
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/api/work-order-assignments/:id",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const deleted = await deleteAssignment(request.params.id);
      if (!deleted) {
        reply.code(404);
        return { error: "unknown assignment" };
      }
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "work_order_unassigned",
        target: request.params.id,
        ipAddress: request.ip,
      });
      reply.code(204);
      return null;
    },
  );
  app.get("/api/terminal-uis", async () => listTerminalUis());

  app.get<{ Params: { id: string } }>("/api/terminal-uis/:id", async (request, reply) => {
    const ui = await getTerminalUi(request.params.id);
    if (!ui) {
      reply.code(404);
      return { error: "unknown terminal UI" };
    }
    return ui;
  });

  app.post<{ Body: { name: string; machineIds: string[] } }>(
    "/api/terminal-uis",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const { name, machineIds } = request.body;
      if (!name) {
        reply.code(400);
        return { error: "name is required" };
      }
      try {
        const ui = await createTerminalUi(name, machineIds ?? []);
        await recordAuditEvent({
          actorId: request.user!.id,
          action: "terminal_ui_created",
          target: ui.id,
          details: { name, machineIds },
          ipAddress: request.ip,
        });
        reply.code(201);
        return ui;
      } catch (err) {
        if (isTerminalUiUniqueViolation(err)) {
          reply.code(409);
          return { error: `terminal UI with name "${name}" already exists` };
        }
        throw err;
      }
    },
  );

  app.put<{ Params: { id: string }; Body: { name?: string; machineIds?: string[] } }>(
    "/api/terminal-uis/:id",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const ui = await updateTerminalUi(request.params.id, request.body);
      if (!ui) {
        reply.code(404);
        return { error: "unknown terminal UI" };
      }
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "terminal_ui_updated",
        target: ui.id,
        details: request.body,
        ipAddress: request.ip,
      });
      return ui;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/terminal-uis/:id",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const deleted = await deleteTerminalUi(request.params.id);
      if (!deleted) {
        reply.code(404);
        return { error: "unknown terminal UI" };
      }
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "terminal_ui_deleted",
        target: request.params.id,
        ipAddress: request.ip,
      });
      reply.code(204);
      return null;
    },
  );

  return app;
}