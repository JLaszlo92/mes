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
import {
  listFaultCodes,
  createFaultCode,
  deactivateFaultCode,
  FaultCodeLimitError,
  isUniqueViolation as isFaultCodeUniqueViolation,
  isForeignKeyViolation as isFaultCodeForeignKeyViolation,
} from "./machine-fault-codes-repository.js";
import {
  listFaultReports,
  createFaultReport,
  reviewFaultReport,
  isForeignKeyViolation as isFaultReportForeignKeyViolation,
} from "./fault-reports-repository.js";
import { listLots, getLotForWorkOrder, generateLotForWorkOrder } from "./lots-repository.js";
import {
  listMaterialLots,
  createMaterialLot,
  listConsumptionForWorkOrder,
  recordConsumption,
  isUniqueViolation as isMaterialLotUniqueViolation,
  isForeignKeyViolation as isMaterialLotForeignKeyViolation,
} from "./material-lots-repository.js";
import {
  listCorrectiveActions,
  createCorrectiveAction,
  signOffCorrectiveAction,
  isForeignKeyViolation as isCorrectiveActionForeignKeyViolation,
} from "./corrective-actions-repository.js";
import {
  listCurrentInstructions,
  getCurrentInstructionForPart,
  listVersionsForPart,
  createNewVersion,
  recordView,
  listViews,
} from "./work-instructions-repository.js";
import {
  listMaintenanceWorkOrders,
  getMaintenanceWorkOrder,
  createMaintenanceWorkOrder,
  updateMaintenanceWorkOrder,
  listParts,
  addPart,
  listLabor,
  addLabor,
  isForeignKeyViolation as isMwoForeignKeyViolation,
} from "./maintenance-work-orders-repository.js";
import {
  listSchedules,
  createSchedule,
  deactivateSchedule,
  resetSchedule,
  isForeignKeyViolation as isScheduleForeignKeyViolation,
} from "./preventive-maintenance-repository.js";
import {
  listStatusDefinitions,
  createStatusDefinition,
  deleteStatusDefinition,
  isForeignKeyViolation as isStatusDefForeignKeyViolation,
  isUniqueViolation as isStatusDefUniqueViolation,
} from "./machine-status-definitions-repository.js";


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


  app.get<{ Querystring: { from?: string; to?: string; limit?: string; offset?: string } }>(
    "/api/audit-log",
    { preHandler: requireRole("admin") },
    async (request) => {
      const { from, to, limit, offset } = request.query;
      return listAuditLog({
        from,
        to,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      });
    },
  );

  app.get<{ Querystring: { from: string; to: string } }>("/api/shifts/summary", async (request, reply) => {
    const { from, to } = request.query;
    if (!from || !to) {
      reply.code(400);
      return { error: "from and to query parameters are required" };
    }
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      reply.code(400);
      return { error: "from and to must be valid ISO date strings" };
    }
    return getShiftSummary(fromDate, toDate);
  });

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
    if (request.body.status === "completed") {
      await generateLotForWorkOrder(workOrder.id);
    }
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

  app.get<{ Querystring: { machineId?: string } }>("/api/fault-codes", async (request) =>
  listFaultCodes(request.query.machineId),
  );

  app.post<{ Body: { machineId: string; code: string; name: string; signalReference?: string } }>(
    "/api/fault-codes",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const { machineId, code, name } = request.body;
      if (!machineId || !code || !name) {
        reply.code(400);
        return { error: "machineId, code and name are required" };
      }
      try {
        const faultCode = await createFaultCode(request.body);
        await recordAuditEvent({
          actorId: request.user!.id,
          action: "fault_code_created",
          target: faultCode.id,
          details: request.body,
          ipAddress: request.ip,
        });
        reply.code(201);
        return faultCode;
      } catch (err) {
        if (err instanceof FaultCodeLimitError) {
          reply.code(409);
          return { error: err.message };
        }
        if (isFaultCodeUniqueViolation(err)) {
          reply.code(409);
          return { error: `code "${code}" already exists for this machine` };
        }
        if (isFaultCodeForeignKeyViolation(err)) {
          reply.code(404);
          return { error: "unknown machine" };
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/fault-codes/:id",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const deactivated = await deactivateFaultCode(request.params.id);
      if (!deactivated) {
        reply.code(404);
        return { error: "unknown fault code" };
      }
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "fault_code_deactivated",
        target: request.params.id,
        ipAddress: request.ip,
      });
      reply.code(204);
      return null;
    },
  );

  app.get("/api/fault-reports", async (request, reply) => {
    if (!request.user) {
      reply.code(401);
      return { error: "authentication required" };
    }
    return listFaultReports();
  });

  app.post<{ Body: { machineId: string; faultCodeId: string; occurrenceCount?: number; comment?: string } }>(
    "/api/fault-reports",
    async (request, reply) => {
      if (!request.user) {
        reply.code(401);
        return { error: "authentication required" };
      }
      const { machineId, faultCodeId } = request.body;
      if (!machineId || !faultCodeId) {
        reply.code(400);
        return { error: "machineId and faultCodeId are required" };
      }
      try {
        const report = await createFaultReport({ ...request.body, reportedBy: request.user.id });
        await recordAuditEvent({
          actorId: request.user.id,
          action: "fault_reported",
          target: report.id,
          details: request.body,
          ipAddress: request.ip,
        });
        reply.code(201);
        return report;
      } catch (err) {
        if (isFaultReportForeignKeyViolation(err)) {
          reply.code(404);
          return { error: "unknown machine or fault code" };
        }
        throw err;
      }
    },
  );

  app.put<{
    Params: { id: string };
    Body: { status: "confirmed" | "modified" | "rejected"; adjustedCount?: number; reviewerNote?: string };
  }>("/api/fault-reports/:id/review", { preHandler: requireRole("manager", "admin") }, async (request, reply) => {
    const report = await reviewFaultReport(request.params.id, request.user!.id, request.body);
    if (!report) {
      reply.code(404);
      return { error: "unknown or already reviewed fault report" };
    }
    await recordAuditEvent({
      actorId: request.user!.id,
      action: "fault_report_reviewed",
      target: report.id,
      details: request.body,
      ipAddress: request.ip,
    });
    return report;
  });
  app.get("/api/lots", async (request, reply) => {
  if (!request.user) {
    reply.code(401);
    return { error: "authentication required" };
  }
  return listLots();
  });

  app.get<{ Params: { id: string } }>("/api/work-orders/:id/lot", async (request, reply) => {
    if (!request.user) {
      reply.code(401);
      return { error: "authentication required" };
    }
    const lot = await getLotForWorkOrder(request.params.id);
    if (!lot) {
      reply.code(404);
      return { error: "no lot generated yet for this work order" };
    }
    return lot;
  });

  app.get("/api/material-lots", async (request, reply) => {
    if (!request.user) {
      reply.code(401);
      return { error: "authentication required" };
    }
    return listMaterialLots();
  });

  app.post<{ Body: { materialName: string; lotNumber: string; supplier?: string; receivedAt?: string } }>(
    "/api/material-lots",
    async (request, reply) => {
      if (!request.user) {
        reply.code(401);
        return { error: "authentication required" };
      }
      const { materialName, lotNumber } = request.body;
      if (!materialName || !lotNumber) {
        reply.code(400);
        return { error: "materialName and lotNumber are required" };
      }
      try {
        const lot = await createMaterialLot(request.body);
        await recordAuditEvent({
          actorId: request.user.id,
          action: "material_lot_created",
          target: lot.id,
          details: request.body,
          ipAddress: request.ip,
        });
        reply.code(201);
        return lot;
      } catch (err) {
        if (isMaterialLotUniqueViolation(err)) {
          reply.code(409);
          return { error: "this material name + lot number combination already exists" };
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/work-orders/:id/material-consumption", async (request, reply) => {
    if (!request.user) {
      reply.code(401);
      return { error: "authentication required" };
    }
    return listConsumptionForWorkOrder(request.params.id);
  });

  app.post<{ Params: { id: string }; Body: { materialLotId: string } }>(
    "/api/work-orders/:id/material-consumption",
    async (request, reply) => {
      if (!request.user) {
        reply.code(401);
        return { error: "authentication required" };
      }
      const { materialLotId } = request.body;
      if (!materialLotId) {
        reply.code(400);
        return { error: "materialLotId is required" };
      }
      try {
        await recordConsumption(request.params.id, materialLotId, request.user.id);
        await recordAuditEvent({
          actorId: request.user.id,
          action: "material_consumption_recorded",
          target: request.params.id,
          details: request.body,
          ipAddress: request.ip,
        });
        reply.code(201);
        return { success: true };
      } catch (err) {
        if (isMaterialLotForeignKeyViolation(err)) {
          reply.code(404);
          return { error: "unknown work order or material lot" };
        }
        throw err;
      }
    },
  );
  app.get("/api/corrective-actions", async (request, reply) => {
  if (!request.user) {
    reply.code(401);
    return { error: "authentication required" };
  }
    return listCorrectiveActions();
  });

  app.post<{ Body: { faultReportId: string; description: string } }>(
    "/api/corrective-actions",
    async (request, reply) => {
      if (!request.user) {
        reply.code(401);
        return { error: "authentication required" };
      }
      const { faultReportId, description } = request.body;
      if (!faultReportId || !description) {
        reply.code(400);
        return { error: "faultReportId and description are required" };
      }
      try {
        const action = await createCorrectiveAction({ faultReportId, description, performedBy: request.user.id });
        await recordAuditEvent({
          actorId: request.user.id,
          action: "corrective_action_logged",
          target: action.id,
          details: { faultReportId, description },
          ipAddress: request.ip,
        });
        reply.code(201);
        return action;
      } catch (err) {
        if (isCorrectiveActionForeignKeyViolation(err)) {
          reply.code(404);
          return { error: "unknown fault report" };
        }
        throw err;
      }
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/corrective-actions/:id/sign-off",
    { preHandler: requireRole("supervisor", "manager", "admin") },
    async (request, reply) => {
      const action = await signOffCorrectiveAction(request.params.id, request.user!.id);
      if (!action) {
        reply.code(404);
        return { error: "unknown or already signed-off corrective action" };
      }
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "corrective_action_signed_off",
        target: action.id,
        ipAddress: request.ip,
      });
      return action;
    },
    );

      app.get("/api/work-instructions", async (request, reply) => {
    if (!request.user) {
      reply.code(401);
      return { error: "authentication required" };
    }
    return listCurrentInstructions();
  });

  app.get<{ Params: { partName: string } }>("/api/work-instructions/:partName", async (request, reply) => {
    if (!request.user) {
      reply.code(401);
      return { error: "authentication required" };
    }
    const instruction = await getCurrentInstructionForPart(decodeURIComponent(request.params.partName));
    if (!instruction) {
      reply.code(404);
      return { error: "no instructions for this part" };
    }
    return instruction;
  });

  app.get<{ Params: { partName: string } }>("/api/work-instructions/:partName/versions", async (request, reply) => {
    if (!request.user) {
      reply.code(401);
      return { error: "authentication required" };
    }
    return listVersionsForPart(decodeURIComponent(request.params.partName));
  });

  app.post<{ Body: { partName: string; content: string; pdfUrl?: string } }>(
    "/api/work-instructions",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const { partName, content } = request.body;
      if (!partName || !content) {
        reply.code(400);
        return { error: "partName and content are required" };
      }
      const instruction = await createNewVersion({ ...request.body, createdBy: request.user!.id });
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "work_instruction_versioned",
        target: instruction.id,
        details: { partName, version: instruction.version },
        ipAddress: request.ip,
      });
      reply.code(201);
      return instruction;
    },
  );

  app.post<{ Body: { workInstructionId: string; workOrderId?: string } }>(
    "/api/work-instructions/view",
    async (request, reply) => {
      if (!request.user) {
        reply.code(401);
        return { error: "authentication required" };
      }
      const { workInstructionId, workOrderId } = request.body;
      if (!workInstructionId) {
        reply.code(400);
        return { error: "workInstructionId is required" };
      }
      await recordView(workInstructionId, workOrderId ?? null, request.user.id);
      reply.code(201);
      return { success: true };
    },
  );

  app.get(
    "/api/work-instructions/views/log",
    { preHandler: requireRole("admin", "manager", "supervisor") },
    async () => listViews(),
  );
  app.get("/api/maintenance-work-orders", async (request, reply) => {
  if (!request.user) {
    reply.code(401);
    return { error: "authentication required" };
  }
  return listMaintenanceWorkOrders();
  });

  app.post<{
    Body: { machineId: string; title: string; description?: string; sourceType?: string; sourceId?: string };
  }>("/api/maintenance-work-orders", { preHandler: requireRole("maintenance", "manager", "admin") }, async (request, reply) => {
    const { machineId, title } = request.body;
    if (!machineId || !title) {
      reply.code(400);
      return { error: "machineId and title are required" };
    }
    try {
      const mwo = await createMaintenanceWorkOrder({ ...request.body, createdBy: request.user!.id });
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "maintenance_work_order_created",
        target: mwo.id,
        details: request.body,
        ipAddress: request.ip,
      });
      reply.code(201);
      return mwo;
    } catch (err) {
      if (isMwoForeignKeyViolation(err)) {
        reply.code(404);
        return { error: "unknown machine" };
      }
      throw err;
    }
  });

  app.put<{
    Params: { id: string };
    Body: { status?: "open" | "assigned" | "in_progress" | "closed"; assignedTo?: string };
  }>("/api/maintenance-work-orders/:id", { preHandler: requireRole("maintenance", "manager", "admin") }, async (request, reply) => {
    const mwo = await updateMaintenanceWorkOrder(request.params.id, request.body);
    if (!mwo) {
      reply.code(404);
      return { error: "unknown maintenance work order" };
    }
    await recordAuditEvent({
      actorId: request.user!.id,
      action: "maintenance_work_order_updated",
      target: mwo.id,
      details: request.body,
      ipAddress: request.ip,
    });
    if (request.body.status === "closed" && mwo.sourceType === "preventive_schedule" && mwo.sourceId) {
      await resetSchedule(mwo.sourceId);
    }
    return mwo;
  });

  app.get<{ Params: { id: string } }>("/api/maintenance-work-orders/:id/parts", async (request, reply) => {
    if (!request.user) {
      reply.code(401);
      return { error: "authentication required" };
    }
    return listParts(request.params.id);
  });

  app.post<{ Params: { id: string }; Body: { partName: string; quantity?: number } }>(
    "/api/maintenance-work-orders/:id/parts",
    { preHandler: requireRole("supervisor", "maintenance", "manager", "admin") },
    async (request, reply) => {
      const { partName, quantity } = request.body;
      if (!partName) {
        reply.code(400);
        return { error: "partName is required" };
      }
      await addPart(request.params.id, partName, quantity ?? 1);
      reply.code(201);
      return { success: true };
    },
  );

  app.get<{ Params: { id: string } }>("/api/maintenance-work-orders/:id/labor", async (request, reply) => {
    if (!request.user) {
      reply.code(401);
      return { error: "authentication required" };
    }
    return listLabor(request.params.id);
  });

  app.post<{ Params: { id: string }; Body: { hours: number; notes?: string } }>(
    "/api/maintenance-work-orders/:id/labor",
    { preHandler: requireRole("maintenance", "manager", "admin") },
    async (request, reply) => {
      const { hours } = request.body;
      if (!hours || hours <= 0) {
        reply.code(400);
        return { error: "hours must be a positive number" };
      }
      await addLabor(request.params.id, request.user!.id, hours, request.body.notes);
      reply.code(201);
      return { success: true };
    },
  );
  app.get(
  "/api/preventive-schedules",
  { preHandler: requireRole("maintenance", "manager", "admin") },
  async () => listSchedules(),
  );

  app.post<{
    Body: { machineId: string; triggerType: "calendar" | "usage_hours" | "part_count"; intervalValue: number; description: string };
  }>("/api/preventive-schedules", { preHandler: requireRole("maintenance", "manager", "admin") }, async (request, reply) => {
    const { machineId, triggerType, intervalValue, description } = request.body;
    if (!machineId || !triggerType || !intervalValue || !description) {
      reply.code(400);
      return { error: "machineId, triggerType, intervalValue and description are required" };
    }
    try {
      const schedule = await createSchedule(request.body);
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "preventive_schedule_created",
        target: schedule.id,
        details: request.body,
        ipAddress: request.ip,
      });
      reply.code(201);
      return schedule;
    } catch (err) {
      if (isScheduleForeignKeyViolation(err)) {
        reply.code(404);
        return { error: "unknown machine" };
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/api/preventive-schedules/:id",
    { preHandler: requireRole("maintenance", "manager", "admin") },
    async (request, reply) => {
      const deactivated = await deactivateSchedule(request.params.id);
      if (!deactivated) {
        reply.code(404);
        return { error: "unknown schedule" };
      }
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "preventive_schedule_deactivated",
        target: request.params.id,
        ipAddress: request.ip,
      });
      reply.code(204);
      return null;
    },
  );
  app.get(
  "/api/status-definitions",
  { preHandler: requireRole("admin", "manager") },
  async () => listStatusDefinitions(),
);

app.post<{
  Body: { machineId?: string; code: string; displayName: string; oeeCategory: "counts_as_down" | "excluded"; color?: string };
}>("/api/status-definitions", { preHandler: requireRole("admin", "manager") }, async (request, reply) => {
  const { code, displayName, oeeCategory } = request.body;
  if (!code || !displayName || !oeeCategory) {
    reply.code(400);
    return { error: "code, displayName and oeeCategory are required" };
  }
  if (code === "running" || code === "down") {
    reply.code(400);
    return { error: "'running' and 'down' are built-in and cannot be redefined" };
  }
  try {
    const def = await createStatusDefinition(request.body);
    await recordAuditEvent({
      actorId: request.user!.id,
      action: "status_definition_created",
      target: def.id,
      details: request.body,
      ipAddress: request.ip,
    });
    reply.code(201);
    return def;
  } catch (err) {
    if (isStatusDefForeignKeyViolation(err)) {
      reply.code(404);
      return { error: "unknown machine" };
    }
    if (isStatusDefUniqueViolation(err)) {
      reply.code(409);
      return { error: "this code already exists in this scope" };
    }
    throw err;
  }
});

app.delete<{ Params: { id: string } }>(
  "/api/status-definitions/:id",
  { preHandler: requireRole("admin", "manager") },
  async (request, reply) => {
    const deleted = await deleteStatusDefinition(request.params.id);
    if (!deleted) {
      reply.code(404);
      return { error: "unknown status definition" };
    }
    await recordAuditEvent({
      actorId: request.user!.id,
      action: "status_definition_deleted",
      target: request.params.id,
      ipAddress: request.ip,
    });
    reply.code(204);
    return null;
  },
  );
  return app;
}