import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { recordAuditEvent } from "./audit-repository.js";
import { pool } from "./db.js";
import { checkThrottle, clearPinThrottle, pinThrottleKeys, POLICIES, registerThrottleFailure } from "./auth-throttle.js";
import { listFaultCodes } from "./machine-fault-codes-repository.js";
import { createFaultReport, isForeignKeyViolation, listFaultReportsPage } from "./fault-reports-repository.js";
import { generateLotForWorkOrder } from "./lots-repository.js";
import { PERMISSIONS, type Permission } from "./permissions.js";
import { getCurrentShiftSummaryForMachine } from "./shift-summary-repository.js";
import { findTerminalByDeviceToken, type TerminalUi } from "./terminal-uis-repository.js";
import { findUserByPin, getUserById, isPinFormat, type User } from "./users-repository.js";
import { listAssignmentsForMachine, mergeBlocks } from "./work-order-assignments-repository.js";
import { getInstructionFile, getInstructionForWorkOrder, instructionFileExists, recordView } from "./work-instructions-repository.js";
import { getWorkOrderProgress, patchWorkOrder } from "./work-orders-repository.js";
import { workerTickets } from "./terminal-workers.js";
import { closedTotals, closeRun, getOpenRun, listRuns, liveCounts, openRun, reportOutcome } from "./work-order-runs.js";
import { listStatusDefinitions } from "./machine-status-definitions-repository.js";
import { bookScrap, getScrapMode, listScrapReasons, MAX_BOOKING_QUANTITY, reasonsForMachine } from "./scrap-repository.js";
import { currentStatus, endManualStatus, getActiveManualStatus, setManualStatus } from "./manual-status.js";
import { ensureCheck, getCheck, getCheckDetail, lastPieceGate, onWorkOrderClosed, onWorkOrderPaused, onWorkOrderStarted, orderQuality, QualityError, recordMeasurement, releaseCheck, skipCheck } from "./quality-repository.js";

/** Permissions outside "terminal." that are used at the terminal (quality measurements). */
const TERMINAL_EXTRA_PERMISSIONS: readonly string[] = ["quality.measure", "quality.release"];

/** The highest good count a report may give. */
const MAX_REPORTED_GOOD = 1_000_000;

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

type TerminalRequest = FastifyRequest<{ Params: { terminalId: string; workOrderId?: string; fileId?: string; checkId?: string } }>;

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
/** Planned orders sent to the terminal per machine (the nearest ones). */
export const MAX_WAITING = 30;

/**
 * How fast the machine makes parts now: parts in the last hour, and the average cycle of the latest (up to 20)
 * cycles — only while parts keep coming (the last one at most 10 minutes ago), else null.
 */
async function machineRate(machineId: string): Promise<{ partsLastHour: number; cycleSeconds: number | null; idealCycleSeconds: number | null }> {
  const result = await pool.query<{ last_hour: string; first: Date | null; last: Date | null; n: string; ideal: string | null }>(
    `WITH recent AS (
       SELECT "timestamp" FROM events
       WHERE machine_id = $1 AND type = 'production_count' AND "timestamp" >= now() - interval '60 minutes'
       ORDER BY "timestamp" DESC
     )
     SELECT (SELECT count(*) FROM recent) AS last_hour, min(t) AS first, max(t) AS last, count(*) AS n,
            (SELECT ideal_cycle_time_seconds FROM machines WHERE id = $1) AS ideal
     FROM (SELECT "timestamp" AS t FROM recent LIMIT 21) x`,
    [machineId],
  );
  const r = result.rows[0]!;
  const n = Number(r.n);
  const fresh = r.last !== null && Date.now() - new Date(r.last).getTime() <= 10 * 60_000;
  const cycleSeconds = fresh && n >= 3 && r.first && r.last ? (new Date(r.last).getTime() - new Date(r.first).getTime()) / 1000 / (n - 1) : null;
  return { partsLastHour: Number(r.last_hour), cycleSeconds, idealCycleSeconds: r.ideal === null ? null : Number(r.ideal) };
}

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
    const [definitions, scrapReasons, scrapModes] = await Promise.all([
      listStatusDefinitions(),
      listScrapReasons(),
      pool.query<{ id: string; scrap_booking_mode: string }>(`SELECT id, scrap_booking_mode FROM machines WHERE id = ANY($1)`, [terminal.machineIds]),
    ]);
    const machines = await Promise.all(
      terminal.machineIds.map(async (machineId, i) => {
        const [assignments, codes, reports, shift, status, manual, rate] = await Promise.all([
          listAssignmentsForMachine(machineId).then(mergeBlocks),
          listFaultCodes(machineId),
          listFaultReportsPage({ machineIds: [machineId], limit: 5, offset: 0 }),
          getCurrentShiftSummaryForMachine(machineId).catch(() => undefined),
          currentStatus(machineId),
          getActiveManualStatus(machineId),
          machineRate(machineId),
        ]);
        const done = (s: string) => s === "completed" || s === "cancelled";
        // Running and paused orders always; of the planned ones only the next MAX_WAITING (a machine can be planned
        // months ahead — the screen and the start list stay light), the rest only counted.
        const open = assignments.filter((a) => !done(a.workOrderStatus));
        const planned = open.filter((a) => a.workOrderStatus === "planned" || a.workOrderStatus === "released");
        const current = [...open.filter((a) => !planned.includes(a)), ...planned.slice(0, MAX_WAITING)].sort(
          (x, y) => new Date(x.plannedStart).getTime() - new Date(y.plannedStart).getTime(),
        );
        const waitingMore = Math.max(0, planned.length - MAX_WAITING);
        const history = assignments.filter((a) => done(a.workOrderStatus)).slice(-HISTORY_PER_MACHINE).reverse();
        const runningAssignments = current.filter((a) => a.workOrderStatus === "in_progress");
        const running = [...new Set(runningAssignments.map((a) => a.workOrderId))];
        const orders = Object.fromEntries(
          await Promise.all(
            running.map(async (id) => {
              const partName = runningAssignments.find((a) => a.workOrderId === id)!.partName;
              const [progress, instruction, quality, planned] = await Promise.all([
                getWorkOrderProgress(id),
                getInstructionForWorkOrder(id),
                orderQuality(id, partName, machineId),
                pool.query<{ s: string | null }>(`SELECT expected_cycle_time_seconds AS s FROM work_orders WHERE id = $1`, [id]),
              ]);
              const plannedCycle = planned.rows[0]?.s;
              return [
                id,
                {
                  progress: progress ? { goodCount: progress.goodCount, scrapCount: progress.scrapCount, quantity: progress.quantity, remaining: progress.remaining, targetReached: progress.targetReached, operator: progress.operatorEmail, startedAt: progress.startedAt ? new Date(progress.startedAt).toISOString() : null } : null,
                  // Only what the buttons need; the text and the file come when it is opened (and logged).
                  instruction: instruction ? { partName: instruction.partName, version: instruction.version, hasPdf: instruction.pdfFileId !== null } : null,
                  quality,
                  plannedCycleSeconds: plannedCycle != null ? Number(plannedCycle) : null,
                },
              ] as const;
            }),
          ),
        );
        // Paused orders waiting to be resumed here: how far they got and when they were reported off.
        const paused = Object.fromEntries(
          await Promise.all(
            [...new Set(current.filter((a) => a.workOrderStatus === "paused").map((a) => a.workOrderId))].map(async (id) => {
              const [progress, runs] = await Promise.all([getWorkOrderProgress(id), listRuns(id)]);
              const last = runs.filter((r) => r.endedAt !== null).at(-1);
              return [
                id,
                {
                  goodCount: progress?.goodCount ?? 0,
                  scrapCount: progress?.scrapCount ?? 0,
                  quantity: progress?.quantity ?? 0,
                  remaining: progress?.remaining ?? 0,
                  pausedAt: last?.endedAt ?? null,
                  pausedBy: last?.endedByName ?? null,
                  runs: runs.length,
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
          scrapReasons: reasonsForMachine(scrapReasons, machineId).map((r) => ({ id: r.id, code: r.code, name: r.name })),
          scrapMode: scrapModes.rows.find((r) => r.id === machineId)?.scrap_booking_mode ?? "reclassify",
          shift: shift ?? null,
          rate,
          current,
          history,
          waitingMore,
          orders,
          paused,
          faultCodes: codes.filter((c) => c.isActive).map((c) => ({ id: c.id, code: c.code, name: c.name })),
          recentReports: reports.rows.map((r) => ({ id: r.id, faultCode: r.faultCode, faultName: r.faultName, status: r.status, reportedAt: r.reportedAt, reportedBy: r.reportedByEmail })),
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
    const terminalPermissions = user.permissions.filter((p) => p.startsWith("terminal.") || TERMINAL_EXTRA_PERMISSIONS.includes(p));
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

  app.post<{ Params: { terminalId: string; workOrderId: string } }>("/api/terminal/:terminalId/work-orders/:workOrderId/start", async (request, reply) => {
    const terminal = await terminalOf(request, reply);
    if (!terminal) return reply;
    const worker = await workerFor(request, reply, terminal.id, "terminal.start_work_order");
    if (!worker) return reply;
    const workOrderId = request.params.workOrderId;
    // Only on a machine of this terminal the order is scheduled on: a paused order is resumed where it is planned.
    const assignment = await orderOnTerminal(terminal, workOrderId);
    if (!assignment) return fail(reply, 404, "this work order is not scheduled on this terminal's machines");
    if (!["planned", "released", "paused"].includes(assignment.workOrderStatus)) {
      return fail(reply, 409, "this work order cannot be started (it is not planned, released or paused)");
    }
    const resumed = assignment.workOrderStatus === "paused";
    const change = await patchWorkOrder(workOrderId, { status: "in_progress" });
    if (!change) return fail(reply, 404, "unknown work order");
    await openRun({ workOrderId, machineId: assignment.machineId, user: { id: worker.user.id, name: worker.user.name } });
    await recordAuditEvent({
      actorId: worker.user.id,
      actorEmail: worker.user.name,
      action: "work_order_updated",
      target: workOrderId,
      details: { status: "in_progress", resumed, machineId: assignment.machineId, changes: change.changes, terminalId: terminal.id, terminal: terminal.name },
      ipAddress: request.ip,
    });
    await onWorkOrderStarted(workOrderId, assignment.machineId, { resumed });
    return { success: true, status: "in_progress", resumed, workerExpiresAt: worker.expiresAt };
  });

  /** The open run of a running order (one is opened from the first start for an order running since before runs). */
  async function openRunOf(workOrderId: string, machineId: string) {
    const open = await getOpenRun(workOrderId);
    if (open) return open;
    const legacy = await getWorkOrderProgress(workOrderId);
    await pool.query(
      `INSERT INTO work_order_runs (id, work_order_id, machine_id, started_at, started_by_name) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5)
       ON CONFLICT (work_order_id) WHERE ended_at IS NULL DO NOTHING`,
      [randomUUID(), workOrderId, machineId, legacy?.startedAt ?? null, legacy?.operatorEmail ?? null],
    );
    return (await getOpenRun(workOrderId))!;
  }

  // What the report dialog starts from: the machine's count of this run, the earlier runs, the scrap reasons.
  app.get<{ Params: { terminalId: string; workOrderId: string } }>("/api/terminal/:terminalId/work-orders/:workOrderId/report-draft", async (request, reply) => {
    const terminal = await terminalOf(request, reply);
    if (!terminal) return reply;
    const workOrderId = request.params.workOrderId;
    const assignment = await orderOnTerminal(terminal, workOrderId);
    if (!assignment) return fail(reply, 404, "this work order is not scheduled on this terminal's machines");
    if (assignment.workOrderStatus !== "in_progress") return fail(reply, 409, "only a running work order can be reported");
    const wo = (
      await pool.query<{ quantity: number; count_overproduction: boolean; completion_mode: string }>(
        `SELECT quantity, count_overproduction, completion_mode FROM work_orders WHERE id = $1`,
        [workOrderId],
      )
    ).rows[0]!;
    const run = await openRunOf(workOrderId, assignment.machineId);
    const runs = await listRuns(workOrderId);
    const previous = closedTotals(runs);
    const live = await liveCounts(run, runs, wo.quantity, wo.count_overproduction);
    const machineId = run.machineId ?? assignment.machineId;
    return {
      workOrderId,
      orderNumber: assignment.orderNumber,
      partName: assignment.partName,
      quantity: wo.quantity,
      completionMode: wo.completion_mode,
      machineId,
      scrapMode: (await getScrapMode(machineId)) ?? "reclassify",
      previous: { good: previous.good, scrap: previous.scrap, runs: runs.length - 1 },
      run: { startedAt: run.startedAt, startedBy: run.startedByName, good: live.good, scrap: live.scrap, byReason: live.byReason },
      scrapReasons: reasonsForMachine(await listScrapReasons(), machineId).map((r) => ({ id: r.id, code: r.code, name: r.name })),
    };
  });

  /**
   * Reports the order off the machine: the good count and the new scrap by reason. With all the good parts made
   * (and no pause asked) the order completes — the last-piece check first —, otherwise it is paused and can be
   * resumed on its machine. Without a good count (older screens) it completes with the machine's count.
   */
  app.post<{ Params: { terminalId: string; workOrderId: string } }>("/api/terminal/:terminalId/work-orders/:workOrderId/complete", async (request, reply) => {
    const terminal = await terminalOf(request, reply);
    if (!terminal) return reply;
    const worker = await workerFor(request, reply, terminal.id, "terminal.complete_work_order");
    if (!worker) return reply;
    const workOrderId = request.params.workOrderId;
    const assignment = await orderOnTerminal(terminal, workOrderId);
    if (!assignment) return fail(reply, 404, "this work order is not scheduled on this terminal's machines");
    if (assignment.workOrderStatus !== "in_progress") return fail(reply, 409, "only a running work order can be completed or paused");

    const body = (request.body ?? {}) as { good?: unknown; scrap?: unknown; pause?: unknown; skipLastPiece?: unknown };
    const pause = body.pause === true;
    let good: number | undefined;
    if (body.good !== undefined && body.good !== null) {
      good = typeof body.good === "number" ? body.good : Number(body.good);
      if (!Number.isInteger(good) || good < 0 || good > MAX_REPORTED_GOOD) return fail(reply, 400, `the good count is a whole number from 0 to ${MAX_REPORTED_GOOD}`, { code: "good" });
    }
    const run = await openRunOf(workOrderId, assignment.machineId);
    const machineId = run.machineId ?? assignment.machineId;
    const reasons = reasonsForMachine(await listScrapReasons(), machineId);
    const lines: { reason: (typeof reasons)[number]; quantity: number }[] = [];
    if (body.scrap !== undefined) {
      if (!Array.isArray(body.scrap) || body.scrap.length > 50) return fail(reply, 400, "scrap is a list of {reasonId, quantity}", { code: "scrap" });
      for (const item of body.scrap as { reasonId?: unknown; quantity?: unknown }[]) {
        const quantity = typeof item?.quantity === "number" ? item.quantity : Number(item?.quantity);
        if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_BOOKING_QUANTITY) {
          return fail(reply, 400, `a scrap quantity is a whole number from 0 to ${MAX_BOOKING_QUANTITY}`, { code: "quantity" });
        }
        if (quantity === 0) continue;
        const reason = reasons.find((r) => r.id === item.reasonId);
        if (!reason) return fail(reply, 400, "unknown scrap reason for this machine", { code: "reason" });
        const same = lines.find((l) => l.reason.id === reason.id);
        if (same) same.quantity += quantity;
        else lines.push({ reason, quantity });
      }
    }
    const newScrap = lines.reduce((a, l) => a + l.quantity, 0);
    if (newScrap > MAX_BOOKING_QUANTITY) return fail(reply, 400, `at most ${MAX_BOOKING_QUANTITY} scrap parts at once`, { code: "quantity" });

    const wo = (await pool.query<{ quantity: number; count_overproduction: boolean }>(`SELECT quantity, count_overproduction FROM work_orders WHERE id = $1`, [workOrderId])).rows[0]!;
    const runs = await listRuns(workOrderId);
    const previous = closedTotals(runs);
    const before = await liveCounts(run, runs, wo.quantity, wo.count_overproduction);
    const mode = (await getScrapMode(machineId)) ?? "reclassify";
    if (mode === "reclassify" && newScrap > before.good) {
      return fail(reply, 409, `only ${before.good} good parts are counted in this run`, { code: "too_many", good: before.good });
    }
    const reportedGood = good ?? before.good - (mode === "reclassify" ? newScrap : 0);
    const completing = reportOutcome({ previousGood: previous.good, good: good === undefined ? undefined : reportedGood, quantity: wo.quantity, pause }) === "completed";

    if (completing) {
      // The last-piece check: a gating one must pass first; an optional one is offered and may be skipped.
      const gate = await lastPieceGate(workOrderId, machineId);
      if (!gate.ok) {
        const skip = body.skipLastPiece === true;
        if (gate.gating) return fail(reply, 409, "the last-piece check has to pass before this order can be completed", { code: "quality_check_required", checkId: gate.checkId });
        if (!skip) return fail(reply, 409, "a last-piece check is planned for this order", { code: "quality_check_offered", checkId: gate.checkId });
        await skipCheck(gate.checkId, { id: worker.user.id, name: worker.user.name });
        await recordAuditEvent({
          actorId: worker.user.id,
          actorEmail: worker.user.name,
          action: "quality_check_skipped",
          target: gate.checkId,
          details: { workOrderId, kind: "last_piece", terminalId: terminal.id, terminal: terminal.name },
          ipAddress: request.ip,
        });
      }
    }

    // The new scrap is booked like any scrap report: the machine's counts, the shift and the OEE see it too.
    for (const line of lines) {
      const booking = await bookScrap({
        machineId,
        workOrderId,
        reason: line.reason,
        quantity: line.quantity,
        note: completing ? "Lejelentés — lezárás" : "Lejelentés — szüneteltetés",
        mode,
        user: { id: worker.user.id, name: worker.user.name },
        terminal: { id: terminal.id, name: terminal.name },
      });
      await recordAuditEvent({
        actorId: worker.user.id,
        actorEmail: worker.user.name,
        action: "scrap_booked",
        target: booking.id,
        details: { machineId, workOrderId, orderNumber: assignment.orderNumber, reason: line.reason.code, reasonName: line.reason.name, quantity: line.quantity, mode, report: true, terminalId: terminal.id, terminal: terminal.name },
        ipAddress: request.ip,
      });
    }
    const after = lines.length > 0 ? await liveCounts(run, runs, wo.quantity, wo.count_overproduction) : before;
    const status = completing ? "completed" : "paused";
    await closeRun({
      runId: run.id,
      endReason: status,
      counted: { good: after.good, scrap: after.scrap },
      reported: { good: reportedGood, scrap: after.scrap },
      breakdown: after.byReason,
      manual: good !== undefined,
      user: { id: worker.user.id, name: worker.user.name },
      terminal: { id: terminal.id, name: terminal.name },
    });
    const change = await patchWorkOrder(workOrderId, { status });
    if (!change) return fail(reply, 404, "unknown work order");
    const report = {
      good: reportedGood,
      scrap: after.scrap,
      countedGood: after.good,
      newScrap: lines.map((l) => ({ code: l.reason.code, name: l.reason.name, quantity: l.quantity })),
      totalGood: previous.good + reportedGood,
      quantity: wo.quantity,
      pauseAsked: pause,
    };
    await recordAuditEvent({
      actorId: worker.user.id,
      actorEmail: worker.user.name,
      action: "work_order_updated",
      target: workOrderId,
      details: { status, report, changes: change.changes, terminalId: terminal.id, terminal: terminal.name },
      ipAddress: request.ip,
    });
    if (completing) {
      await generateLotForWorkOrder(workOrderId);
      await onWorkOrderClosed(workOrderId);
    } else {
      await onWorkOrderPaused(workOrderId);
    }
    return { success: true, status, report, workerExpiresAt: worker.expiresAt };
  });

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

  // ---- quality checks at the terminal ----

  /** The check, if it belongs to one of this terminal's machines. */
  async function checkOnTerminal(terminal: TerminalUi, checkId: string) {
    const check = await getCheck(checkId);
    return check && check.machineId && terminal.machineIds.includes(check.machineId) ? check : undefined;
  }

  function qualityFail(reply: FastifyReply, err: unknown) {
    if (err instanceof QualityError) return fail(reply, err.httpStatus, err.message, { code: err.code });
    throw err;
  }

  // The check to measure: its characteristics in order, with the attempts so far and the one that is next.
  app.get<{ Params: { terminalId: string; checkId: string } }>("/api/terminal/:terminalId/quality-checks/:checkId", async (request, reply) => {
    const terminal = await terminalOf(request, reply);
    if (!terminal) return reply;
    if (!(await checkOnTerminal(terminal, request.params.checkId))) return fail(reply, 404, "this check is not on this terminal's machines");
    return getCheckDetail(request.params.checkId);
  });

  app.post<{ Params: { terminalId: string; checkId: string } }>("/api/terminal/:terminalId/quality-checks/:checkId/measurements", async (request, reply) => {
    const terminal = await terminalOf(request, reply);
    if (!terminal) return reply;
    const worker = await workerFor(request, reply, terminal.id, "quality.measure");
    if (!worker) return reply;
    const check = await checkOnTerminal(terminal, request.params.checkId);
    if (!check) return fail(reply, 404, "this check is not on this terminal's machines");
    const body = (request.body ?? {}) as { characteristicId?: unknown; value?: unknown; ok?: unknown; comment?: unknown };
    if (typeof body.characteristicId !== "string") return fail(reply, 400, "which measurement?");
    const value = typeof body.value === "number" ? body.value : typeof body.value === "string" && body.value.trim() !== "" ? Number(body.value.replace(",", ".")) : null;
    if (value !== null && !Number.isFinite(value)) return fail(reply, 400, "the value is not a number", { code: "value_required" });
    const comment = typeof body.comment === "string" && body.comment.trim() ? body.comment.trim().slice(0, 500) : null;
    try {
      const result = await recordMeasurement({
        checkId: check.id,
        characteristicId: body.characteristicId,
        value,
        ok: typeof body.ok === "boolean" ? body.ok : null,
        comment,
        userId: worker.user.id,
        userName: worker.user.name,
        terminalId: terminal.id,
        terminalName: terminal.name,
      });
      if (!result.passed || result.status === "passed") {
        await recordAuditEvent({
          actorId: worker.user.id,
          actorEmail: worker.user.name,
          action: result.passed ? "quality_check_passed" : "quality_measurement_failed",
          target: check.id,
          details: { workOrderId: check.workOrderId, orderNumber: check.orderNumber, kind: check.kind, characteristicId: body.characteristicId, value, ok: body.ok, terminalId: terminal.id, terminal: terminal.name },
          ipAddress: request.ip,
        });
      }
      reply.code(201);
      return { ...result, check: await getCheckDetail(check.id), workerExpiresAt: worker.expiresAt };
    } catch (err) {
      return qualityFail(reply, err);
    }
  });

  app.post<{ Params: { terminalId: string; checkId: string } }>("/api/terminal/:terminalId/quality-checks/:checkId/release", async (request, reply) => {
    const terminal = await terminalOf(request, reply);
    if (!terminal) return reply;
    const worker = await workerFor(request, reply, terminal.id, "quality.release");
    if (!worker) return reply;
    const check = await checkOnTerminal(terminal, request.params.checkId);
    if (!check) return fail(reply, 404, "this check is not on this terminal's machines");
    const reason = (request.body as { reason?: unknown } | undefined)?.reason;
    if (typeof reason !== "string" || reason.trim().length < 3) return fail(reply, 400, "give the reason of the release", { code: "reason_required" });
    try {
      const released = await releaseCheck(check.id, reason.trim().slice(0, 500), { id: worker.user.id, name: worker.user.name });
      await recordAuditEvent({
        actorId: worker.user.id,
        actorEmail: worker.user.name,
        action: "quality_check_released",
        target: check.id,
        details: { workOrderId: check.workOrderId, orderNumber: check.orderNumber, kind: check.kind, from: check.status, reason: reason.trim(), terminalId: terminal.id, terminal: terminal.name },
        ipAddress: request.ip,
      });
      return { check: released, workerExpiresAt: worker.expiresAt };
    } catch (err) {
      return qualityFail(reply, err);
    }
  });

  // An extra spot check now (e.g. after a tool change), whether or not the plan has regular ones.
  app.post<{ Params: { terminalId: string; workOrderId: string } }>("/api/terminal/:terminalId/work-orders/:workOrderId/spot-check", async (request, reply) => {
    const terminal = await terminalOf(request, reply);
    if (!terminal) return reply;
    const worker = await workerFor(request, reply, terminal.id, "quality.measure");
    if (!worker) return reply;
    const assignment = await orderOnTerminal(terminal, request.params.workOrderId);
    if (!assignment) return fail(reply, 404, "this work order is not scheduled on this terminal's machines");
    if (assignment.workOrderStatus !== "in_progress") return fail(reply, 409, "only a running work order can be checked");
    const checkId = await ensureCheck({ workOrderId: assignment.workOrderId, kind: "spot", trigger: "manual", machineId: assignment.machineId });
    if (!checkId) return fail(reply, 409, "the quality plan of this part has no spot-check measurements", { code: "no_spot_plan" });
    await recordAuditEvent({
      actorId: worker.user.id,
      actorEmail: worker.user.name,
      action: "quality_check_requested",
      target: checkId,
      details: { workOrderId: assignment.workOrderId, orderNumber: assignment.orderNumber, kind: "spot", terminalId: terminal.id, terminal: terminal.name },
      ipAddress: request.ip,
    });
    return { checkId, workerExpiresAt: worker.expiresAt };
  });

  // Scrap with a reason: on the machine's running order (or the one given), counted as the machine is set up (scrap-repository.ts).
  app.post<{ Params: { terminalId: string; machineId: string } }>("/api/terminal/:terminalId/machines/:machineId/scrap", async (request, reply) => {
    const terminal = await terminalOf(request as unknown as TerminalRequest, reply);
    if (!terminal) return reply;
    const worker = await workerFor(request as unknown as TerminalRequest, reply, terminal.id, "terminal.report_scrap");
    if (!worker) return reply;
    const machineId = request.params.machineId;
    if (!terminal.machineIds.includes(machineId)) return fail(reply, 400, "this machine is not on this terminal");
    const body = (request.body ?? {}) as { reasonId?: unknown; quantity?: unknown; workOrderId?: unknown; note?: unknown };
    const quantity = typeof body.quantity === "number" ? body.quantity : Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_BOOKING_QUANTITY) return fail(reply, 400, `the quantity is a whole number from 1 to ${MAX_BOOKING_QUANTITY}`, { code: "quantity" });
    const reason = reasonsForMachine(await listScrapReasons(), machineId).find((r) => r.id === body.reasonId);
    if (!reason) return fail(reply, 400, "unknown scrap reason for this machine", { code: "reason" });
    const running = (await listAssignmentsForMachine(machineId)).filter((a) => a.workOrderStatus === "in_progress");
    const order = typeof body.workOrderId === "string" ? running.find((a) => a.workOrderId === body.workOrderId) : running[0];
    if (typeof body.workOrderId === "string" && !order) return fail(reply, 409, "this work order is not running on this machine", { code: "order" });
    const mode = (await getScrapMode(machineId)) ?? "reclassify";
    if (mode === "reclassify") {
      // The parts come off the good ones: there have to be that many.
      const progress = order ? await getWorkOrderProgress(order.workOrderId) : undefined;
      const good = progress?.goodCount ?? 0;
      if (!order) return fail(reply, 409, "no running order on this machine: scrap cannot be taken off the good parts", { code: "no_order" });
      if (quantity > good) return fail(reply, 409, `only ${good} good parts are counted on this order`, { code: "too_many", good });
    }
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 300) : null;
    const booking = await bookScrap({
      machineId,
      workOrderId: order?.workOrderId ?? null,
      reason,
      quantity,
      note,
      mode,
      user: { id: worker.user.id, name: worker.user.name },
      terminal: { id: terminal.id, name: terminal.name },
    });
    await recordAuditEvent({
      actorId: worker.user.id,
      actorEmail: worker.user.name,
      action: "scrap_booked",
      target: booking.id,
      details: { machineId, workOrderId: order?.workOrderId ?? null, orderNumber: order?.orderNumber ?? null, reason: reason.code, reasonName: reason.name, quantity, mode, terminalId: terminal.id, terminal: terminal.name },
      ipAddress: request.ip,
    });
    reply.code(201);
    return { id: booking.id, mode, workerExpiresAt: worker.expiresAt };
  });
}
