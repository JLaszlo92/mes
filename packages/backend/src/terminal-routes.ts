import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { recordAuditEvent } from "./audit-repository.js";
import { checkThrottle, clearPinThrottle, pinThrottleKeys, POLICIES, registerThrottleFailure } from "./auth-throttle.js";
import { listFaultCodes } from "./machine-fault-codes-repository.js";
import { createFaultReport, isForeignKeyViolation, listFaultReportsPage } from "./fault-reports-repository.js";
import { generateLotForWorkOrder } from "./lots-repository.js";
import { PERMISSIONS, type Permission } from "./permissions.js";
import { getCurrentShiftSummaryForMachine } from "./shift-summary-repository.js";
import { findTerminalByDeviceToken, type TerminalUi } from "./terminal-uis-repository.js";
import { findUserByPin, getUserById, isPinFormat, type User } from "./users-repository.js";
import { listAssignmentsForMachine } from "./work-order-assignments-repository.js";
import { getInstructionFile, getInstructionForWorkOrder, instructionFileExists, recordView } from "./work-instructions-repository.js";
import { getWorkOrderProgress, patchWorkOrder } from "./work-orders-repository.js";
import { workerTickets } from "./terminal-workers.js";
import { listStatusDefinitions } from "./machine-status-definitions-repository.js";
import { currentStatus, endManualStatus, getActiveManualStatus, setManualStatus } from "./manual-status.js";

/**
 * A gép melletti terminál API-ja.
 *
 * - A **párosított eszköz** (Admin → Terminals → Pair device) saját tokennel
 *   azonosítja magát (`X-Terminal-Token`): így a terminál bejelentkezés
 *   nélkül, újraindítás után is működik, de csak a saját gépeit látja.
 * - **Minden változtatáshoz** (rendelés indítása/lezárása, hibajelentés,
 *   munkautasítás megnyitása) a dolgozó személyes, 5 jegyű PIN-je kell: a
 *   `unlock` egy 60 másodperces, minden művelettel megújuló jegyet ad
 *   (`X-Worker-Ticket`), és a művelet a dolgozó nevében, az ő szerepének
 *   jogosultságával fut, az audit naplóba is így kerül.
 *
 * Ezek a route-ok az auth guard PUBLIC_ROUTES listáján vannak, mert itt a
 * hitelesítést ez a fájl végzi, nem a dashboard sessionje.
 */

type TerminalRequest = FastifyRequest<{ Params: { terminalId: string; workOrderId?: string; fileId?: string } }>;

function fail(reply: FastifyReply, code: number, error: string, extra: Record<string, unknown> = {}) {
  reply.code(code);
  return { error, ...extra };
}

function header(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

async function terminalOf(request: TerminalRequest, reply: FastifyReply): Promise<TerminalUi | undefined> {
  const token = header(request, "x-terminal-token");
  const terminal = token ? await findTerminalByDeviceToken(request.params.terminalId, token) : undefined;
  if (!terminal) {
    reply.code(401).send({ error: "this screen is not paired with the terminal", code: "terminal_not_paired" });
    return undefined;
  }
  return terminal;
}

/** The worker of the ticket, if they hold `permission`; otherwise the reply is sent and undefined returned. */
async function workerFor(request: TerminalRequest, reply: FastifyReply, terminalId: string, permission: Permission): Promise<{ user: User; expiresAt: number } | undefined> {
  const ticket = workerTickets.use(terminalId, header(request, "x-worker-ticket"));
  const user = ticket ? await getUserById(ticket.userId) : undefined;
  if (!ticket || !user) {
    reply.code(401).send({ error: "enter your code", code: "worker_required" });
    return undefined;
  }
  if (!user.permissions.includes(permission)) {
    const label = PERMISSIONS.find((p) => p.key === permission)?.label ?? permission;
    reply.code(403).send({ error: `${user.name} does not have the permission: ${label}`, code: "permission", permission });
    return undefined;
  }
  return { user, expiresAt: ticket.expiresAt };
}

const HISTORY_PER_MACHINE = 10;

/**
 * The statuses a worker may set on a machine: its own definitions, then the global ones not overridden by code.
 * off_shift is left out: the shift calendar sets it, not the operator.
 */
function statusOptionsFor(
  definitions: { machineId: string | null; code: string; displayName: string; oeeCategory: string; color: string | null; blocksProduction: boolean }[],
  machineId: string,
): { code: string; label: string; oeeCategory: string; color: string | null; blocksProduction: boolean }[] {
  definitions = definitions.filter((d) => d.code !== "off_shift");
  const own = definitions.filter((d) => d.machineId === machineId);
  const global = definitions.filter((d) => d.machineId === null && !own.some((o) => o.code === d.code));
  return [...own, ...global].map((d) => ({ code: d.code, label: d.displayName, oeeCategory: d.oeeCategory, color: d.color, blocksProduction: d.blocksProduction }));
}

export default async function terminalRoutes(app: FastifyInstance): Promise<void> {
  // Everything the screen shows, in one request (polled every few seconds).
  app.get<{ Params: { terminalId: string } }>("/api/terminal/:terminalId/state", async (request, reply) => {
    const terminal = await terminalOf(request, reply);
    if (!terminal) return reply;
    const definitions = await listStatusDefinitions();
    const machines = await Promise.all(
      terminal.machineIds.map(async (machineId, i) => {
        const [assignments, codes, reports, shift, status, manual] = await Promise.all([
          listAssignmentsForMachine(machineId),
          listFaultCodes(machineId),
          listFaultReportsPage({ machineIds: [machineId], limit: 5, offset: 0 }),
          getCurrentShiftSummaryForMachine(machineId).catch(() => undefined),
          currentStatus(machineId),
          getActiveManualStatus(machineId),
        ]);
        const done = (s: string) => s === "completed" || s === "cancelled";
        const current = assignments.filter((a) => !done(a.workOrderStatus));
        const history = assignments.filter((a) => done(a.workOrderStatus)).slice(-HISTORY_PER_MACHINE).reverse();
        const running = [...new Set(current.filter((a) => a.workOrderStatus === "in_progress").map((a) => a.workOrderId))];
        const orders = Object.fromEntries(
          await Promise.all(
            running.map(async (id) => {
              const [progress, instruction] = await Promise.all([getWorkOrderProgress(id), getInstructionForWorkOrder(id)]);
              return [
                id,
                {
                  progress: progress ? { goodCount: progress.goodCount, scrapCount: progress.scrapCount, quantity: progress.quantity, remaining: progress.remaining, targetReached: progress.targetReached, operator: progress.operatorEmail } : null,
                  // Only what the buttons need; the text and the file come when it is opened (and logged).
                  instruction: instruction ? { partName: instruction.partName, version: instruction.version, hasPdf: instruction.pdfFileId !== null } : null,
                },
              ] as const;
            }),
          ),
        );
        return {
          id: machineId,
          name: terminal.machineNames[i] ?? machineId,
          status: status
            ? {
                code: status.status,
                since: status.since,
                manual: manual ? { code: manual.statusCode, setBy: manual.setByName, setAt: manual.setAt, blocksProduction: manual.blocksProduction } : null,
              }
            : null,
          statusOptions: statusOptionsFor(definitions, machineId),
          shift: shift ?? null,
          current,
          history,
          orders,
          faultCodes: codes.filter((c) => c.isActive).map((c) => ({ id: c.id, code: c.code, name: c.name })),
          recentReports: reports.rows.map((r) => ({ id: r.id, faultCode: r.faultCode, status: r.status })),
        };
      }),
    );
    return { terminal: { id: terminal.id, name: terminal.name }, machines };
  });

  app.post<{ Params: { terminalId: string } }>("/api/terminal/:terminalId/unlock", async (request, reply) => {
    const terminal = await terminalOf(request, reply);
    if (!terminal) return reply;
    const pin = (request.body as { pin?: unknown } | undefined)?.pin;
    const keys = pinThrottleKeys(terminal.id);
    const blocked = await checkThrottle(keys);
    if (blocked) {
      reply.header("Retry-After", String(blocked.retryAfterSeconds));
      return fail(reply, 429, `Too many wrong codes. Try again in ${Math.ceil(blocked.retryAfterSeconds / 60)} min.`, { code: "locked", retryAfterSeconds: blocked.retryAfterSeconds });
    }
    const user = isPinFormat(pin) ? await findUserByPin(pin) : undefined;
    if (!user) {
      const locked = await registerThrottleFailure(keys);
      if (locked.length > 0) {
        await recordAuditEvent({ actorEmail: `terminal ${terminal.name}`, action: "terminal_pin_locked", target: terminal.id, details: { lockMinutes: POLICIES.pin.lockMinutes }, ipAddress: request.ip });
      }
      return fail(reply, 401, "wrong code", { code: "wrong_pin" });
    }
    await clearPinThrottle(terminal.id);
    const terminalPermissions = user.permissions.filter((p) => p.startsWith("terminal."));
    if (terminalPermissions.length === 0) {
      return fail(reply, 403, `${user.name} has no permission to work at the terminal`, { code: "permission" });
    }
    const { ticket, expiresAt } = workerTickets.issue(terminal.id, user.id);
    return { ticket, expiresAt, worker: { id: user.id, name: user.name, roleName: user.roleName, permissions: terminalPermissions } };
  });

  app.post<{ Params: { terminalId: string } }>("/api/terminal/:terminalId/lock", async (request, reply) => {
    const terminal = await terminalOf(request, reply);
    if (!terminal) return reply;
    workerTickets.end(terminal.id, header(request, "x-worker-ticket"));
    return { success: true };
  });

  /** A work order is this terminal's business only if it is scheduled on one of its machines. */
  async function orderOnTerminal(terminal: TerminalUi, workOrderId: string) {
    for (const machineId of terminal.machineIds) {
      const found = (await listAssignmentsForMachine(machineId)).find((a) => a.workOrderId === workOrderId);
      if (found) return found;
    }
    return undefined;
  }

  async function changeStatus(request: TerminalRequest, reply: FastifyReply, to: "in_progress" | "completed") {
    const terminal = await terminalOf(request, reply);
    if (!terminal) return reply;
    const worker = await workerFor(request, reply, terminal.id, to === "in_progress" ? "terminal.start_work_order" : "terminal.complete_work_order");
    if (!worker) return reply;
    const workOrderId = request.params.workOrderId!;
    const assignment = await orderOnTerminal(terminal, workOrderId);
    if (!assignment) return fail(reply, 404, "this work order is not scheduled on this terminal's machines");
    const allowedFrom = to === "in_progress" ? ["planned", "released"] : ["in_progress"];
    if (!allowedFrom.includes(assignment.workOrderStatus)) {
      return fail(reply, 409, to === "in_progress" ? "this work order cannot be started (it is not planned or released)" : "only a running work order can be completed");
    }
    const change = await patchWorkOrder(workOrderId, { status: to });
    if (!change) return fail(reply, 404, "unknown work order");
    // computeWorkOrderProgress reads the start from this event (details.status = in_progress).
    await recordAuditEvent({
      actorId: worker.user.id,
      actorEmail: worker.user.name,
      action: "work_order_updated",
      target: workOrderId,
      details: { status: to, changes: change.changes, terminalId: terminal.id, terminal: terminal.name },
      ipAddress: request.ip,
    });
    if (to === "completed") await generateLotForWorkOrder(workOrderId);
    return { success: true, status: to, workerExpiresAt: worker.expiresAt };
  }

  app.post<{ Params: { terminalId: string; workOrderId: string } }>("/api/terminal/:terminalId/work-orders/:workOrderId/start", (request, reply) =>
    changeStatus(request, reply, "in_progress"),
  );
  app.post<{ Params: { terminalId: string; workOrderId: string } }>("/api/terminal/:terminalId/work-orders/:workOrderId/complete", (request, reply) =>
    changeStatus(request, reply, "completed"),
  );

  app.post<{ Params: { terminalId: string } }>("/api/terminal/:terminalId/fault-reports", async (request, reply) => {
    const terminal = await terminalOf(request, reply);
    if (!terminal) return reply;
    const worker = await workerFor(request, reply, terminal.id, "terminal.report_fault");
    if (!worker) return reply;
    const body = (request.body ?? {}) as { machineId?: unknown; faultCodeId?: unknown };
    if (typeof body.machineId !== "string" || !terminal.machineIds.includes(body.machineId)) return fail(reply, 400, "this machine is not on this terminal");
    if (typeof body.faultCodeId !== "string") return fail(reply, 400, "choose a fault");
    const codes = await listFaultCodes(body.machineId);
    if (!codes.some((c) => c.id === body.faultCodeId && c.isActive)) return fail(reply, 400, "unknown fault code for this machine");
    try {
      const report = await createFaultReport({ machineId: body.machineId, faultCodeId: body.faultCodeId, occurrenceCount: 1, reportedBy: worker.user.id });
      await recordAuditEvent({
        actorId: worker.user.id,
        actorEmail: worker.user.name,
        action: "fault_report_created",
        target: report.id,
        details: { machineId: body.machineId, faultCodeId: body.faultCodeId, terminalId: terminal.id, terminal: terminal.name },
        ipAddress: request.ip,
      });
      reply.code(201);
      return { success: true, workerExpiresAt: worker.expiresAt };
    } catch (err) {
      if (isForeignKeyViolation(err)) return fail(reply, 400, "unknown machine or fault code");
      throw err;
    }
  });

  // Set a status from Status definitions, or end the manual one ({ end: true }): back to the machine's signal.
  app.post<{ Params: { terminalId: string; machineId: string } }>("/api/terminal/:terminalId/machines/:machineId/status", async (request, reply) => {
    const terminal = await terminalOf(request as unknown as TerminalRequest, reply);
    if (!terminal) return reply;
    const worker = await workerFor(request as unknown as TerminalRequest, reply, terminal.id, "terminal.set_status");
    if (!worker) return reply;
    const machineId = request.params.machineId;
    if (!terminal.machineIds.includes(machineId)) return fail(reply, 400, "this machine is not on this terminal");
    const body = (request.body ?? {}) as { code?: unknown; end?: unknown };
    if (body.end === true) {
      const ended = await endManualStatus(machineId, "operator", worker.user.id);
      if (!ended) return fail(reply, 409, "no status was set by hand on this machine");
      await recordAuditEvent({
        actorId: worker.user.id,
        actorEmail: worker.user.name,
        action: "machine_status_ended",
        target: machineId,
        details: { status: ended.statusCode, backTo: ended.signalStatus, terminalId: terminal.id, terminal: terminal.name },
        ipAddress: request.ip,
      });
      return { success: true, workerExpiresAt: worker.expiresAt };
    }
    const options = statusOptionsFor(await listStatusDefinitions(), machineId);
    const option = options.find((o) => o.code === body.code);
    if (!option) return fail(reply, 400, "unknown status for this machine");
    await setManualStatus({ machineId, statusCode: option.code, userId: worker.user.id, userName: worker.user.name, terminalId: terminal.id });
    await recordAuditEvent({
      actorId: worker.user.id,
      actorEmail: worker.user.name,
      action: "machine_status_set",
      target: machineId,
      details: { status: option.code, label: option.label, oeeCategory: option.oeeCategory, blocksProduction: option.blocksProduction, terminalId: terminal.id, terminal: terminal.name },
      ipAddress: request.ip,
    });
    return { success: true, workerExpiresAt: worker.expiresAt };
  });

  // Opening an instruction is what the view log records: who, which version, for which order.
  app.post<{ Params: { terminalId: string; workOrderId: string } }>("/api/terminal/:terminalId/work-orders/:workOrderId/instruction", async (request, reply) => {
    const terminal = await terminalOf(request, reply);
    if (!terminal) return reply;
    const worker = await workerFor(request, reply, terminal.id, "terminal.open_instructions");
    if (!worker) return reply;
    if (!(await orderOnTerminal(terminal, request.params.workOrderId))) return fail(reply, 404, "this work order is not scheduled on this terminal's machines");
    const instruction = await getInstructionForWorkOrder(request.params.workOrderId);
    if (!instruction) return fail(reply, 404, "no work instruction for this work order");
    await recordView(instruction.id, request.params.workOrderId, worker.user.id);
    return { instruction, workerExpiresAt: worker.expiresAt };
  });

  // The PDF: the paired device is enough (the opening itself needed the worker and was logged).
  app.get<{ Params: { terminalId: string; fileId: string } }>("/api/terminal/:terminalId/instruction-files/:fileId", async (request, reply) => {
    const terminal = await terminalOf(request, reply);
    if (!terminal) return reply;
    if (!(await instructionFileExists(request.params.fileId))) return fail(reply, 404, "unknown file");
    const file = await getInstructionFile(request.params.fileId);
    if (!file) return fail(reply, 404, "unknown file");
    return reply
      .header("Content-Type", "application/pdf")
      .header("Cache-Control", "private, max-age=3600")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .send(file.content);
  });
}
