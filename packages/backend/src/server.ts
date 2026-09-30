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
import { deleteSession } from "./sessions-repository.js";
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
import {
  listEdgeNodes,
  createEdgeNode,
  deleteEdgeNode,
  regenerateToken,
  addChannel,
  deleteChannel,
  claimEdgeNode,
  recordHeartbeat,
  DuplicateSessionError,
  InvalidTokenError,
  InvalidSessionError,
  isForeignKeyViolation as isEdgeNodeForeignKeyViolation,
} from "./edge-nodes-repository.js";
import {
  listUnexplainedDowntimePeriods,
  explainDowntimePeriod,
  getDowntimeSummary,
  setMicroStopThreshold,
} from "./downtime-periods-repository.js";
import { getMachineHistory, type BucketUnit } from "./machine-history-repository.js";
import { getWorkOrderProgress } from "./work-orders-repository.js";
import { getCurrentShiftSummaryForMachine } from "./shift-summary-repository.js";
import { getStatusTimeline } from "./machine-status-timeline-repository.js";
import {
  listShiftPatterns,
  createShiftPattern,
  deleteShiftPattern,
  addShiftToPattern,
  deleteShift,
  listCalendars,
  createCalendar,
  updateCalendarWorkingDays,
  deleteCalendar,
  assignMachineScheduling,
} from "./shift-patterns-repository.js";
import { getCurrentShiftSummaryForAllMachines } from "./shift-summary-repository.js";
import { validateSchedulingWindow } from "./shift-patterns-repository.js";
import { getOffShiftSegments } from "./off-shift-segments-repository.js";

import {
  updateAssignment,
  replaceScheduleForWorkOrder,
  clearScheduleForWorkOrder,
  ScheduleConflictError,
} from "./work-order-assignments-repository.js";
import { planScheduleChunks, MAX_SCHEDULE_MS, type SchedulePlanRequest } from "./work-order-scheduling.js";
import { registerAuthGuard, authModeFromEnv } from "./auth-guard.js";
import {
  issueWsTicket,
  redeemWsTicket,
  WsTicketCapacityError,
  WS_MAX_LIFETIME_MS,
  WS_CLOSE_INVALID_TICKET,
  WS_CLOSE_REAUTH,
} from "./ws-tickets.js";
import authRoutes from "./auth-routes.js";


export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(websocket);
  await app.register(authPlugin);
  registerAuthGuard(app, authModeFromEnv());
  await app.register(authRoutes);

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

/**
   * Egyszer használható, 30 mp-ig érvényes ticket a dashboard WebSockethez.
   * A deny-by-default auth guard ide csak érvényes sessionnel enged; a
   * request.user ellenőrzés defence-in-depth.
   */
  app.post("/api/auth/ws-ticket", async (request, reply) => {
    if (!request.user) {
      reply.code(401);
      return { error: "authentication required" };
    }
    try {
      return issueWsTicket(request.user.id);
    } catch (err) {
      if (err instanceof WsTicketCapacityError) {
        reply.code(503);
        return { error: err.message };
      }
      throw err;
    }
  });
 
  app.register(async (scoped) => {
    // A /ws az auth guard PUBLIC_ROUTES listáján marad (a böngésző nem tud
    // Authorization headert küldeni), a hitelesítést itt a ticket végzi.
    scoped.get("/ws", { websocket: true }, (socket, request) => {
      const { ticket } = request.query as { ticket?: string };
      const redeemed = ticket ? redeemWsTicket(ticket) : undefined;
      if (!redeemed) {
        request.log.warn({ ip: request.ip }, "dashboard websocket rejected: missing, invalid, used or expired ticket");
        socket.close(WS_CLOSE_INVALID_TICKET, "invalid or expired ticket");
        return;
      }
 
      request.log.info({ userId: redeemed.userId }, "dashboard client connected");
      socket.send(JSON.stringify({ type: "snapshot", machines: stateStore.getAll() }));
 
      const onEvent = (event: unknown) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "event", event }));
      };
      eventHub.on(MACHINE_EVENT, onEvent);
 
      // Maximális élettartam: utána a kliens friss tickettel csatlakozik
      // újra — ha közben lejárt vagy visszavonták a sessionjét, az új ticket
      // kérése már 401-et kap, és nincs újracsatlakozás.
      const lifetimeTimer = setTimeout(() => socket.close(WS_CLOSE_REAUTH, "re-authenticate"), WS_MAX_LIFETIME_MS);
 
      socket.on("close", () => {
        clearTimeout(lifetimeTimer);
        eventHub.off(MACHINE_EVENT, onEvent);
        request.log.info({ userId: redeemed.userId }, "dashboard client disconnected");
      });
    });
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
  // --- Admin CRUD (emberi session-token véd) ---

  app.get("/api/edge-nodes", { preHandler: requireRole("admin", "manager") }, async () => listEdgeNodes());

  app.post<{ Body: { name: string } }>(
    "/api/edge-nodes",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const { name } = request.body;
      if (!name) {
        reply.code(400);
        return { error: "name is required" };
      }
      const created = await createEdgeNode(name);
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "edge_node_created",
        target: created.id,
        details: { name },
        ipAddress: request.ip,
      });
      reply.code(201);
      return created;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/edge-nodes/:id",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const deleted = await deleteEdgeNode(request.params.id);
      if (!deleted) {
        reply.code(404);
        return { error: "unknown edge node" };
      }
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "edge_node_deleted",
        target: request.params.id,
        ipAddress: request.ip,
      });
      reply.code(204);
      return null;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/edge-nodes/:id/regenerate-token",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const token = await regenerateToken(request.params.id);
      if (!token) {
        reply.code(404);
        return { error: "unknown edge node" };
      }
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "edge_node_token_regenerated",
        target: request.params.id,
        ipAddress: request.ip,
      });
      return { token };
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      machineId?: string;
      signalSource: "simulated" | "gpio" | "s7" | "opcua" | "modbus";
      connectionConfig?: Record<string, unknown>;
      statusMode?: "status_bit" | "signal_presence";
      noSignalTimeoutSeconds?: number;
      acceptProductionWhileDown?: boolean;
    };
  }>("/api/edge-nodes/:id/channels", { preHandler: requireRole("admin", "manager") }, async (request, reply) => {
    const { signalSource } = request.body;
    if (!signalSource) {
      reply.code(400);
      return { error: "signalSource is required" };
    }
    try {
      const channel = await addChannel(request.params.id, request.body);
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "edge_node_channel_added",
        target: channel.id,
        details: request.body,
        ipAddress: request.ip,
      });
      reply.code(201);
      return channel;
    } catch (err) {
      if (isEdgeNodeForeignKeyViolation(err)) {
        reply.code(404);
        return { error: "unknown edge node or machine" };
      }
      throw err;
    }
  });

  app.delete<{ Params: { channelId: string } }>(
    "/api/edge-node-channels/:channelId",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const deleted = await deleteChannel(request.params.channelId);
      if (!deleted) {
        reply.code(404);
        return { error: "unknown channel" };
      }
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "edge_node_channel_removed",
        target: request.params.channelId,
        ipAddress: request.ip,
      });
      reply.code(204);
      return null;
    },
  );

  app.post<{ Body: { token: string } }>("/api/edge-nodes/claim", async (request, reply) => {
    const { token } = request.body;
    if (!token) {
      reply.code(400);
      return { error: "token is required" };
    }
    try {
      return await claimEdgeNode(token);
    } catch (err) {
      if (err instanceof DuplicateSessionError) {
        reply.code(409);
        return { error: err.message };
      }
      if (err instanceof InvalidTokenError) {
        reply.code(401);
        return { error: err.message };
      }
      throw err;
    }
  });

    app.post<{ Body: { token: string; sessionId: string } }>("/api/edge-nodes/heartbeat", async (request, reply) => {
      const { token, sessionId } = request.body;
      if (!token || !sessionId) {
        reply.code(400);
        return { error: "token and sessionId are required" };
      }
      try {
        await recordHeartbeat(token, sessionId);
        return { success: true };
      } catch (err) {
        if (err instanceof InvalidSessionError) {
          reply.code(409);
          return { error: err.message };
        }
        if (err instanceof InvalidTokenError) {
          reply.code(401);
          return { error: err.message };
        }
        throw err;
      }
    });
      app.get<{ Querystring: { machineId?: string } }>("/api/downtime-periods/unexplained", async (request, reply) => {
    if (!request.user) {
      reply.code(401);
      return { error: "authentication required" };
    }
    return listUnexplainedDowntimePeriods(request.query.machineId);
  });

  app.post<{ Params: { id: string }; Body: { faultCodeId: string; comment?: string } }>(
    "/api/downtime-periods/:id/explain",
    async (request, reply) => {
      if (!request.user) {
        reply.code(401);
        return { error: "authentication required" };
      }
      const { faultCodeId } = request.body;
      if (!faultCodeId) {
        reply.code(400);
        return { error: "faultCodeId is required" };
      }
      const report = await explainDowntimePeriod(request.params.id, { ...request.body, reportedBy: request.user.id });
      if (!report) {
        reply.code(404);
        return { error: "unknown or already explained downtime period" };
      }
      await recordAuditEvent({
        actorId: request.user.id,
        action: "downtime_period_explained",
        target: request.params.id,
        details: request.body,
        ipAddress: request.ip,
      });
      reply.code(201);
      return report;
    },
  );
  /** Gépenkénti leállás-összesítő (leállások, mikroleállások, magyarázatlanok) az utolsó `hours` órára. */
  app.get<{ Querystring: { hours?: string } }>("/api/downtime-periods/summary", async (request, reply) => {
    const hours = request.query.hours === undefined ? 24 : Number(request.query.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 31) {
      reply.code(400);
      return { error: "hours must be an integer between 1 and 744" };
    }
    return getDowntimeSummary(hours);
  });
 
  /** A gép mikroleállási küszöbe másodpercben (0–3600); 0 = minden leállást magyarázni kell. */
  app.put<{ Params: { id: string }; Body: { seconds?: unknown } }>(
    "/api/machine-registry/:id/micro-stop-threshold",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const seconds = request.body?.seconds;
      if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 0 || seconds > 3600) {
        reply.code(400);
        return { error: "seconds must be an integer between 0 and 3600" };
      }
      const result = await setMicroStopThreshold(request.params.id, seconds);
      if (!result) {
        reply.code(404);
        return { error: "unknown machine" };
      }
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "machine_micro_stop_threshold_updated",
        target: request.params.id,
        details: { previous: result.previous, seconds },
        ipAddress: request.ip,
      });
      return { machineId: request.params.id, microStopThresholdSeconds: seconds };
    },
  );

  app.get<{ Params: { machineId: string }; Querystring: { from: string; to: string; bucket?: string } }>(
    "/api/machines/:machineId/history",
    async (request, reply) => {
      if (!request.user) {
        reply.code(401);
        return { error: "authentication required" };
      }
      const { from, to, bucket } = request.query;
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
      const bucketUnit = (bucket ?? "day") as BucketUnit;
      if (!["hour", "day", "week", "month"].includes(bucketUnit)) {
        reply.code(400);
        return { error: "bucket must be one of: hour, day, week, month" };
      }
      return getMachineHistory(request.params.machineId, fromDate, toDate, bucketUnit);
    },
  );
  app.get<{ Params: { id: string } }>("/api/work-orders/:id/progress", async (request, reply) => {
    if (!request.user) {
      reply.code(401);
      return { error: "authentication required" };
    }
    const progress = await getWorkOrderProgress(request.params.id);
    if (!progress) {
      reply.code(404);
      return { error: "unknown work order" };
    }
    return progress;
    });

    app.get<{ Params: { machineId: string } }>("/api/machines/:machineId/current-shift", async (request, reply) => {
      const summary = await getCurrentShiftSummaryForMachine(request.params.machineId);
      if (!summary) {
        reply.code(404);
        return { error: "no shift data available" };
      }
      return summary;
  });

  app.get<{ Params: { machineId: string }; Querystring: { from: string; to: string } }>(
    "/api/machines/:machineId/status-timeline",
    async (request, reply) => {
      if (!request.user) {
        reply.code(401);
        return { error: "authentication required" };
      }
      const { from, to } = request.query;
      if (!from || !to) {
        reply.code(400);
        return { error: "from and to are required" };
      }
      return getStatusTimeline(request.params.machineId, new Date(from), new Date(to));
    },
  );


  const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
 
  function isValidWorkingDays(value: unknown): value is boolean[] {
    return Array.isArray(value) && value.length === 7 && value.every((d) => typeof d === "boolean");
  }
 
  app.get("/api/shift-patterns", { preHandler: requireRole("admin", "manager") }, async () => listShiftPatterns());
 
  app.post<{ Body: { name?: string } }>(
    "/api/shift-patterns",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const name = request.body?.name?.trim();
      if (!name) {
        reply.code(400);
        return { error: "name is required" };
      }
      const pattern = await createShiftPattern(name);
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "shift_pattern_created",
        target: pattern.id,
        details: { name },
        ipAddress: request.ip,
      });
      reply.code(201);
      return pattern;
    },
  );
 
  app.delete<{ Params: { id: string } }>(
    "/api/shift-patterns/:id",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      try {
        const deleted = await deleteShiftPattern(request.params.id);
        if (!deleted) {
          reply.code(404);
          return { error: "unknown pattern" };
        }
      } catch (err) {
        if (isForeignKeyViolation(err)) {
          reply.code(409);
          return { error: "this shift pattern is still assigned to a machine — reassign the machine first" };
        }
        throw err;
      }
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "shift_pattern_deleted",
        target: request.params.id,
        ipAddress: request.ip,
      });
      reply.code(204);
      return null;
    },
  );
 
  app.post<{ Params: { id: string }; Body: { name?: string; startTime?: string; endTime?: string } }>(
    "/api/shift-patterns/:id/shifts",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const name = request.body?.name?.trim();
      const { startTime, endTime } = request.body ?? {};
      if (!name || !startTime || !endTime) {
        reply.code(400);
        return { error: "name, startTime and endTime are required" };
      }
      if (!TIME_OF_DAY.test(startTime) || !TIME_OF_DAY.test(endTime)) {
        reply.code(400);
        return { error: "startTime and endTime must be HH:MM (24-hour)" };
      }
      try {
        const shift = await addShiftToPattern(request.params.id, { name, startTime, endTime });
        await recordAuditEvent({
          actorId: request.user!.id,
          action: "shift_added",
          target: shift.id,
          details: { shiftPatternId: request.params.id, name, startTime, endTime },
          ipAddress: request.ip,
        });
        reply.code(201);
        return shift;
      } catch (err) {
        if (isForeignKeyViolation(err)) {
          reply.code(404);
          return { error: "unknown pattern" };
        }
        throw err;
      }
    },
  );
 
  app.delete<{ Params: { shiftId: string } }>(
    "/api/shift-pattern-shifts/:shiftId",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const deleted = await deleteShift(request.params.shiftId);
      if (!deleted) {
        reply.code(404);
        return { error: "unknown shift" };
      }
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "shift_deleted",
        target: request.params.shiftId,
        ipAddress: request.ip,
      });
      reply.code(204);
      return null;
    },
  );
 
  app.get("/api/calendars", { preHandler: requireRole("admin", "manager") }, async () => listCalendars());
 
  app.post<{ Body: { name?: string; workingDays?: unknown } }>(
    "/api/calendars",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const name = request.body?.name?.trim();
      const workingDays = request.body?.workingDays;
      if (!name) {
        reply.code(400);
        return { error: "name is required" };
      }
      if (!isValidWorkingDays(workingDays)) {
        reply.code(400);
        return { error: "workingDays must be an array of 7 booleans" };
      }
      const calendar = await createCalendar(name, workingDays);
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "calendar_created",
        target: calendar.id,
        details: { name, workingDays },
        ipAddress: request.ip,
      });
      reply.code(201);
      return calendar;
    },
  );
 
  app.put<{ Params: { id: string }; Body: { workingDays?: unknown } }>(
    "/api/calendars/:id",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const workingDays = request.body?.workingDays;
      if (!isValidWorkingDays(workingDays)) {
        reply.code(400);
        return { error: "workingDays must be an array of 7 booleans" };
      }
      await updateCalendarWorkingDays(request.params.id, workingDays);
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "calendar_updated",
        target: request.params.id,
        details: { workingDays },
        ipAddress: request.ip,
      });
      reply.code(204);
      return null;
    },
  );
 
  app.delete<{ Params: { id: string } }>(
    "/api/calendars/:id",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      try {
        const deleted = await deleteCalendar(request.params.id);
        if (!deleted) {
          reply.code(404);
          return { error: "unknown calendar" };
        }
      } catch (err) {
        if (isForeignKeyViolation(err)) {
          reply.code(409);
          return { error: "this calendar is still assigned to a machine — reassign the machine first" };
        }
        throw err;
      }
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "calendar_deleted",
        target: request.params.id,
        ipAddress: request.ip,
      });
      reply.code(204);
      return null;
    },
  );
 
  app.put<{
    Params: { id: string };
    Body: { shiftPatternId?: string; calendarId?: string; autoOffshiftStatus?: boolean };
  }>("/api/machine-registry/:id/scheduling", { preHandler: requireRole("admin", "manager") }, async (request, reply) => {
    try {
      await assignMachineScheduling(request.params.id, request.body ?? {});
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        reply.code(404);
        return { error: "unknown machine, shift pattern or calendar" };
      }
      throw err;
    }
    await recordAuditEvent({
      actorId: request.user!.id,
      action: "machine_scheduling_updated",
      target: request.params.id,
      details: request.body ?? {},
      ipAddress: request.ip,
    });
    reply.code(204);
    return null;
  });

  app.get("/api/machines/current-shift", async (request, reply) => {
  if (!request.user) {
    reply.code(401);
    return { error: "authentication required" };
  }
  return getCurrentShiftSummaryForAllMachines();
  });
  app.get<{ Params: { machineId: string }; Querystring: { start: string; end: string } }>(
  "/api/machines/:machineId/validate-window",
  async (request, reply) => {
    const { start, end } = request.query;
    if (!start || !end) {
      reply.code(400);
      return { error: "start and end are required" };
    }
    return validateSchedulingWindow(request.params.machineId, new Date(start), new Date(end));
  },
  );

  app.put<{ Params: { id: string }; Body: { machineId?: string; plannedStart?: string; plannedEnd?: string } }>(
  "/api/work-order-assignments/:id",
  { preHandler: requireRole("admin", "manager") },
  async (request, reply) => {
    const assignment = await updateAssignment(request.params.id, request.body);
    if (!assignment) {
      reply.code(404);
      return { error: "unknown assignment" };
    }
    await recordAuditEvent({
      actorId: request.user!.id,
      action: "work_order_assignment_updated",
      target: assignment.id,
      details: request.body,
      ipAddress: request.ip,
    });
    return assignment;
  },
  );

  app.get<{ Params: { machineId: string }; Querystring: { from: string; to: string } }>(
  "/api/machines/:machineId/off-shift-segments",
  async (request, reply) => {
    const { from, to } = request.query;
    if (!from || !to) {
      reply.code(400);
      return { error: "from and to are required" };
    }
    return getOffShiftSegments(request.params.machineId, new Date(from), new Date(to));
  },
  );

    function summarizeSegments(list: { machineId: string; plannedStart: string; plannedEnd: string }[]) {
    return list.map((a) => ({ machineId: a.machineId, plannedStart: a.plannedStart, plannedEnd: a.plannedEnd }));
  }

   app.put<{
    Params: { id: string };
    Body: { machineId?: string; plannedStart?: string; plannedEnd?: string; durationMs?: number };
  }>("/api/work-orders/:id/schedule", { preHandler: requireRole("admin", "manager") }, async (request, reply) => {
    const { machineId, plannedStart, plannedEnd, durationMs } = request.body ?? {};
    if (!machineId || !plannedStart) {
      reply.code(400);
      return { error: "machineId and plannedStart are required" };
    }
    if ((plannedEnd === undefined) === (durationMs === undefined)) {
      reply.code(400);
      return { error: "provide exactly one of plannedEnd or durationMs" };
    }
    const start = new Date(plannedStart);
    if (isNaN(start.getTime())) {
      reply.code(400);
      return { error: "plannedStart must be a valid ISO date string" };
    }
 
    let plan: SchedulePlanRequest;
    if (durationMs !== undefined) {
      if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_SCHEDULE_MS) {
        reply.code(400);
        return { error: "durationMs must be a positive number of at most 60 days" };
      }
      plan = { mode: "duration", start, durationMs };
    } else {
      const end = new Date(plannedEnd!);
      if (isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
        reply.code(400);
        return { error: "plannedEnd must be a valid ISO date string after plannedStart" };
      }
      if (end.getTime() - start.getTime() > MAX_SCHEDULE_MS) {
        reply.code(400);
        return { error: "a single work order cannot span more than 60 days" };
      }
      plan = { mode: "span", start, end };
    }
 
    const planned = await planScheduleChunks(machineId, plan);
    if (!planned.ok) {
      reply.code(400);
      return { error: planned.error };
    }
 
    try {
      const change = await replaceScheduleForWorkOrder(request.params.id, machineId, planned.chunks);
      if (!change) {
        reply.code(404);
        return { error: "unknown work order" };
      }
      await recordAuditEvent({
        actorId: request.user!.id,
        action: "work_order_rescheduled",
        target: request.params.id,
        details: {
          machineId,
          mode: plan.mode,
          previous: summarizeSegments(change.previous),
          current: summarizeSegments(change.current),
        },
        ipAddress: request.ip,
      });
      return change.current;
    } catch (err) {
      if (err instanceof ScheduleConflictError) {
        reply.code(409);
        return { error: err.message };
      }
      if (isForeignKeyViolation(err)) {
        reply.code(404);
        return { error: "unknown machine" };
      }
      throw err;
    }
  });
 
  /** Egy munkarendelés összes szegmensének törlése, atomikusan. */
  app.delete<{ Params: { id: string } }>(
    "/api/work-orders/:id/schedule",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      try {
        const previous = await clearScheduleForWorkOrder(request.params.id);
        if (!previous) {
          reply.code(404);
          return { error: "unknown work order" };
        }
        await recordAuditEvent({
          actorId: request.user!.id,
          action: "work_order_unscheduled",
          target: request.params.id,
          details: { previous: summarizeSegments(previous) },
          ipAddress: request.ip,
        });
        reply.code(204);
        return null;
      } catch (err) {
        if (err instanceof ScheduleConflictError) {
          reply.code(409);
          return { error: err.message };
        }
        throw err;
      }
    },
  );
 

  return app;
}