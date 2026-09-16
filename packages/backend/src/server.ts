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
import { findUserByEmail, getUserById } from "./users-repository.js";
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
import {
  generateSecret,
  buildOtpAuthUrl,
  buildQrCodeDataUrl,
  verifyToken,
  setPendingMfaSecret,
  confirmMfaEnrollment,
  getMfaSecret,
  createPendingLogin,
  consumePendingLogin,
} from "./mfa-repository.js";
import { listAlertRules, createAlertRule, updateAlertRule, deleteAlertRule } from "./alert-rules-repository.js";
import { listAlerts, acknowledgeAlert } from "./alerts-repository.js";

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
    await recordAuditEvent({ actorEmail: email, action: "login_failed", ipAddress: request.ip });
    reply.code(401);
    return { error: "invalid email or password" };
  }

  if (user.mfaEnabled) {
    const pending = await createPendingLogin(user.id);
    return { mfaRequired: true, pendingToken: pending.token, expiresAt: pending.expiresAt };
  }

  const session = await createSession(user.id);
  await recordAuditEvent({
    actorId: user.id,
    actorEmail: user.email,
    action: "login_success",
    ipAddress: request.ip,
  });

  // PRD 8.3: admin/manager esetén kötelező az MFA — ha még nincs
  // beállítva, jelezzük, hogy a kliensnek azonnal be kell állítania.
  const mfaSetupRequired = (user.role === "admin" || user.role === "manager") && !user.mfaEnabled;

  return { token: session.token, role: user.role, expiresAt: session.expiresAt, mfaSetupRequired };
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

  app.post<{ Body: { pendingToken: string; code: string } }>("/api/auth/mfa/login", async (request, reply) => {
  const { pendingToken, code } = request.body;
  const pending = await consumePendingLogin(pendingToken);
  if (!pending) {
    reply.code(401);
    return { error: "invalid or expired login attempt — please sign in again" };
  }
  const secret = await getMfaSecret(pending.userId);
  if (!secret || !verifyToken(secret, code)) {
    await recordAuditEvent({ actorId: pending.userId, action: "mfa_failed", ipAddress: request.ip });
    reply.code(401);
    return { error: "invalid code" };
  }
  const user = await getUserById(pending.userId);
  if (!user) {
    reply.code(404);
    return { error: "user not found" };
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

  app.post("/api/auth/mfa/enroll", async (request, reply) => {
    if (!request.user) {
      reply.code(401);
      return { error: "authentication required" };
    }
    const secret = generateSecret();
    await setPendingMfaSecret(request.user.id, secret);
    const otpAuthUrl = buildOtpAuthUrl(request.user.email, secret);
    const qrCodeDataUrl = await buildQrCodeDataUrl(otpAuthUrl);
    return { secret, otpAuthUrl, qrCodeDataUrl };
  });

  app.post<{ Body: { code: string } }>("/api/auth/mfa/verify-enrollment", async (request, reply) => {
    if (!request.user) {
      reply.code(401);
      return { error: "authentication required" };
    }
    const secret = await getMfaSecret(request.user.id);
    if (!secret || !verifyToken(secret, request.body.code)) {
      reply.code(400);
      return { error: "invalid code" };
    }
    await confirmMfaEnrollment(request.user.id);
    await recordAuditEvent({
      actorId: request.user.id,
      actorEmail: request.user.email,
      action: "mfa_enabled",
      ipAddress: request.ip,
    });
    return { success: true };
  });

  app.get("/api/alert-rules", { preHandler: requireRole("admin", "manager") }, async () => listAlertRules());

  app.post<{
    Body: { type: "machine_down" | "scrap_rate"; machineId?: string; threshold: number; notifyRoles?: string[] };
  }>("/api/alert-rules", { preHandler: requireRole("admin", "manager") }, async (request, reply) => {
    const { type, threshold } = request.body;
    if (!type || threshold === undefined) {
      reply.code(400);
      return { error: "type and threshold are required" };
    }
    const rule = await createAlertRule(request.body);
    await recordAuditEvent({
      actorId: request.user!.id,
      action: "alert_rule_created",
      target: rule.id,
      details: request.body,
      ipAddress: request.ip,
    });
    reply.code(201);
    return rule;
  });

  app.put<{ Params: { id: string }; Body: { threshold?: number; notifyRoles?: string[]; isActive?: boolean } }>(
    "/api/alert-rules/:id",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const rule = await updateAlertRule(request.params.id, request.body);
      if (!rule) {
        reply.code(404);
        return { error: "unknown alert rule" };
      }
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "alert_rule_updated",
        target: rule.id,
        details: request.body,
        ipAddress: request.ip,
      });
      return rule;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/alert-rules/:id",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const deleted = await deleteAlertRule(request.params.id);
      if (!deleted) {
        reply.code(404);
        return { error: "unknown alert rule" };
      }
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "alert_rule_deleted",
        target: request.params.id,
        ipAddress: request.ip,
      });
      reply.code(204);
      return null;
    },
  );

  app.get("/api/alerts", async () => listAlerts());

  app.post<{ Params: { id: string } }>("/api/alerts/:id/acknowledge", async (request, reply) => {
    if (!request.user) {
      reply.code(401);
      return { error: "authentication required" };
    }
    const alert = await acknowledgeAlert(request.params.id, request.user.id);
    if (!alert) {
      reply.code(404);
      return { error: "unknown alert" };
    }
    await recordAuditEvent({
      actorId: request.user.id,
      action: "alert_acknowledged",
      target: alert.id,
      ipAddress: request.ip,
    });
    return alert;
  });

  return app;
}