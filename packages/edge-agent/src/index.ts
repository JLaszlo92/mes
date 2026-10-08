import { mqttTlsOptions } from "./mqtt-tls.js";
import { randomUUID } from "node:crypto";
import mqtt, { type MqttClient } from "mqtt";
import pino from "pino";
import { ackTopic, eventTopic, safeParseAck, type MachineEvent } from "@mes/shared";
import { AckBatcher } from "./ack-batcher.js";
import { RetryTracker } from "./retry-tracker.js";
import { config } from "./config.js";
import { FileEventBuffer } from "./buffer.js";
import { GpioSignalSource } from "./signal-sources/GpioSignalSource.js";
import { S7SignalSource } from "./signal-sources/S7SignalSource.js";
import { OpcUaSignalSource } from "./signal-sources/OpcUaSignalSource.js";
import { SimulatedSignalSource } from "./signal-sources/SimulatedSignalSource.js";
import type { SignalReading, SignalSource } from "./signal-sources/SignalSource.js";
import { ModbusSignalSource } from "./signal-sources/ModbusSignalSource.js";
import { SignalPresenceWatchdog } from "./signal-sources/SignalPresenceWatchdog.js";
import { ProductionGate } from "./signal-sources/ProductionGate.js";
import { decideStartMode, legacyFlagFromEnv, EXIT_CONFIG } from "./start-mode.js";
import { join as joinPath } from "node:path";
import { CounterBaseline } from "./counter-baseline.js";
import { ClaimCache, type CachedClaim } from "./claim-cache.js";
import { CLAIM_TIMEOUT_MS, ClaimHttpError, classifyClaimFailure, sameChannels, startBackgroundClaim } from "./offline-claim.js";
import { claimWaitingOutRejection } from "./initial-claim.js";
import { classifyHeartbeatFailure, HeartbeatHttpError } from "./heartbeat-failure.js";
import { CorrectedClock, clockCorrectionNotice, measureAhead } from "./corrected-clock.js";
import { writeClockOffsetFile } from "./clock-offset-file.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

// ============================================================
// RÉGI, EGY-GÉPES MÓD — env változókból, változatlanul megtartva
// visszafelé kompatibilitás miatt, amíg a meglévő szolgáltatások át
// nem lettek migrálva az edge-node regisztrációra.
// ============================================================

// Per-node settings. In registry mode the backend delivers them on claim; the
// environment value is the fallback (legacy mode, older backends).
const nodeSettings = { catchupMaxMinutes: config.catchupMaxMinutes };

// Corrected wall clock (see corrected-clock.ts): in registry mode the offset against the server is
// measured with the claim and every heartbeat; in legacy mode it stays 0 (the raw device clock).
const clock = new CorrectedClock();

// The S7 Python bridge cannot see `clock`; it re-reads the correction from a file (registry mode only).
let clockOffsetFileActive = false;

/** Writes the current correction for the S7 bridge; until that has worked the bridge uses the value from its environment. */
async function publishClockOffset(): Promise<void> {
  try {
    await writeClockOffsetFile(config.clockOffsetFile, clock.offset);
    clockOffsetFileActive = true;
  } catch (err) {
    log.warn({ err }, "could not write the clock offset file — the S7 bridge keeps the offset it was started with");
  }
}

function counterStateFile(machineId: string): string {
  return joinPath(config.counterStateDir, `counters.${machineId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

function counterBaselineFor(machineId: string): CounterBaseline {
  return new CounterBaseline({
    machineId,
    filePath: counterStateFile(machineId),
    maxAgeMs: nodeSettings.catchupMaxMinutes * 60_000,
    now: () => clock.now(),
    log: { info: (obj, msg) => log.info(obj, msg), warn: (obj, msg) => log.warn(obj, msg) },
  });
}

function s7CatchupEnv(machineId: string): Record<string, string> {
  return {
    COUNTER_STATE_FILE: counterStateFile(machineId),
    CATCHUP_MAX_AGE_SECONDS: String(nodeSettings.catchupMaxMinutes * 60),
    CLOCK_OFFSET_MS: String(clock.offset),
    ...(clockOffsetFileActive ? { CLOCK_OFFSET_FILE: config.clockOffsetFile } : {}),
  };
}

function buildInnerSignalSource(): SignalSource {
  switch (config.signalSource) {
    case "gpio":
      return new GpioSignalSource({
        scriptPath: config.gpio.scriptPath,
        pythonPath: config.gpio.pythonPath,
        env: {
          ...(config.gpio.goodPin ? { GOOD_PIN: config.gpio.goodPin } : {}),
          ...(config.gpio.scrapPin ? { SCRAP_PIN: config.gpio.scrapPin } : {}),
          ...(config.gpio.statusPin ? { STATUS_PIN: config.gpio.statusPin } : {}),
        },
      });
    case "s7":
      return new S7SignalSource({
        scriptPath: config.s7.scriptPath,
        pythonPath: config.s7.pythonPath,
        env: {
          ...(config.s7.plcIp ? { PLC_IP: config.s7.plcIp } : {}),
          ...(config.s7.plcRack ? { PLC_RACK: config.s7.plcRack } : {}),
          ...(config.s7.plcSlot ? { PLC_SLOT: config.s7.plcSlot } : {}),
          ...(config.s7.plcPort ? { PLC_PORT: config.s7.plcPort } : {}),
          ...(config.s7.pollIntervalMs ? { POLL_INTERVAL_MS: config.s7.pollIntervalMs } : {}),
          ...s7CatchupEnv(config.machineId),
        },
      });
    case "opcua":
      return new OpcUaSignalSource({
        endpointUrl: config.opcua.endpointUrl,
        goodCountNodeId: config.opcua.goodCountNodeId,
        scrapCountNodeId: config.opcua.scrapCountNodeId,
        statusNodeId: config.opcua.statusNodeId,
        pollIntervalMs: config.opcua.pollIntervalMs ? parseInt(config.opcua.pollIntervalMs, 10) : undefined,
        counterBaseline: counterBaselineFor(config.machineId),
      });
    case "modbus":
      return new ModbusSignalSource({
        host: config.modbus.host,
        port: config.modbus.port ? parseInt(config.modbus.port, 10) : undefined,
        unitId: config.modbus.unitId ? parseInt(config.modbus.unitId, 10) : undefined,
        goodCountRegister: config.modbus.goodCountRegister ? parseInt(config.modbus.goodCountRegister, 10) : undefined,
        scrapCountRegister: config.modbus.scrapCountRegister ? parseInt(config.modbus.scrapCountRegister, 10) : undefined,
        statusRegister: config.modbus.statusRegister ? parseInt(config.modbus.statusRegister, 10) : undefined,
        pollIntervalMs: config.modbus.pollIntervalMs ? parseInt(config.modbus.pollIntervalMs, 10) : undefined,
        counterBaseline: counterBaselineFor(config.machineId),
      });
    default:
      return new SimulatedSignalSource();
  }
}

function buildLegacySignalSource(): SignalSource {
  const inner = buildInnerSignalSource();
  if (config.statusMode === "signal_presence") {
    return new SignalPresenceWatchdog(inner, config.noSignalTimeoutMs);
  }
  return new ProductionGate(inner, config.acceptProductionWhileDown);
}

function runLegacyMode(): void {
  const source: SignalSource = buildLegacySignalSource();
  const buffer = new FileEventBuffer(config.bufferFilePath);
  const topic = eventTopic(config.machineId);
  const myAckTopic = ackTopic(config.machineId);

  function toMachineEvent(reading: SignalReading): MachineEvent {
    const envelope = { machineId: config.machineId, timestamp: clock.nowIso(), sourceEventId: randomUUID() };
    switch (reading.kind) {
      case "production_count":
        return { ...envelope, type: "production_count", result: reading.result, scrapReasonCode: reading.scrapReasonCode };
      case "machine_status":
        return { ...envelope, type: "machine_status", status: reading.status };
      case "data_gap":
        return { ...envelope, type: "data_gap", reason: reading.reason, gapSeconds: reading.gapSeconds, lostGood: reading.lostGood, lostScrap: reading.lostScrap };
    }
  }

  function publishBestEffort(event: MachineEvent): void {
    if (!client.connected) return;
    client.publish(topic, JSON.stringify(event), { qos: 1 }, (err) => {
      if (err) log.warn({ err, sourceEventId: event.sourceEventId }, "publish attempt failed — will retry");
    });
  }

  function handleReading(reading: SignalReading): void {
    const event = toMachineEvent(reading);
    if (event.type === "production_count") log.debug({ event }, "part event");
    else if (event.type === "data_gap") log.warn({ gap: event }, "parts were not booked (data gap) - reporting it as an event");
    else log.info({ status: event.status, sourceEventId: event.sourceEventId }, "machine status changed");
    buffer.enqueue(event);
    publishBestEffort(event);
  }

  const retryTracker = new RetryTracker();
  const ackBatcher = new AckBatcher((ids) => buffer.removeMany(ids), (err) => log.error({ err }, "failed to remove acknowledged events from the buffer"));

  function retryPending(): void {
    if (!client.connected) return;
    const pending = buffer.readAll();
    const batch = retryTracker.select(pending);
    if (batch.length > 0) log.debug({ pending: pending.length, sending: batch.length }, "retry sweep — republishing unacked events");
    for (const event of batch) publishBestEffort(event);
  }

  const client = mqtt.connect(config.mqttUrl, { ...mqttTlsOptions(), reconnectPeriod: 2000, keepalive: 15, connectTimeout: 10_000, clientId: `edge-agent-${config.machineId}` });

  client.on("connect", () => {
    log.info({ url: config.mqttUrl }, "connected to broker");
    retryTracker.reset();
    client.subscribe(myAckTopic, (err) => {
      if (err) log.error({ err }, "failed to subscribe to ack topic");
    });
    retryPending();
  });
  client.on("reconnect", () => log.warn("reconnecting to broker…"));
  client.on("close", () => log.warn("connection to broker closed"));
  client.on("error", (err) => log.error({ err }, "mqtt client error"));
  client.on("message", (receivedTopic, payload) => {
    if (receivedTopic !== myAckTopic) return;
    let raw: unknown;
    try {
      raw = JSON.parse(payload.toString("utf-8"));
    } catch {
      return;
    }
    const result = safeParseAck(raw);
    if (!result.success) return;
    ackBatcher.add(result.data.sourceEventId);
  });

  const retryTimer = setInterval(retryPending, 4000);
  source.start(handleReading);
  log.info({ machineId: config.machineId, topic, source: source.name }, "edge agent started (legacy mode)");

  function shutdown(): void {
    log.info("shutting down…");
    source.stop();
    clearInterval(retryTimer);
    client.end(false, {}, () => process.exit(0));
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ============================================================
// ÚJ, REGISZTRÁCIÓ-VEZÉRELT MÓD — EDGE_NODE_TOKEN esetén: a konfigurációt
// (tetszőleges számú csatorna/gép) a backendtől kéri le, és rendszeres
// heartbeat-et küld.
// ============================================================

interface ChannelConfig {
  machineId: string;
  signalSource: "simulated" | "gpio" | "s7" | "opcua" | "modbus";
  connectionConfig: Record<string, any>;
  statusMode: "status_bit" | "signal_presence";
  noSignalTimeoutSeconds: number;
  acceptProductionWhileDown: boolean;
}

function buildSourceFromChannel(ch: ChannelConfig): SignalSource {
  const cc = ch.connectionConfig;
  let inner: SignalSource;
  switch (ch.signalSource) {
    case "gpio":
      inner = new GpioSignalSource({
        scriptPath: config.gpio.scriptPath,
        pythonPath: config.gpio.pythonPath,
        env: {
          ...(cc.goodPin ? { GOOD_PIN: String(cc.goodPin) } : {}),
          ...(cc.scrapPin ? { SCRAP_PIN: String(cc.scrapPin) } : {}),
          ...(cc.statusPin ? { STATUS_PIN: String(cc.statusPin) } : {}),
        },
      });
      break;
    case "s7":
      inner = new S7SignalSource({
        scriptPath: config.s7.scriptPath,
        pythonPath: config.s7.pythonPath,
        env: {
          ...(cc.plcIp ? { PLC_IP: String(cc.plcIp) } : {}),
          ...(cc.plcRack !== undefined ? { PLC_RACK: String(cc.plcRack) } : {}),
          ...(cc.plcSlot !== undefined ? { PLC_SLOT: String(cc.plcSlot) } : {}),
          ...(cc.plcPort !== undefined ? { PLC_PORT: String(cc.plcPort) } : {}),
          ...s7CatchupEnv(ch.machineId),
        },
      });
      break;
    case "opcua":
      inner = new OpcUaSignalSource({
        endpointUrl: cc.endpointUrl,
        goodCountNodeId: cc.goodCountNodeId,
        scrapCountNodeId: cc.scrapCountNodeId,
        statusNodeId: cc.statusNodeId,
        counterBaseline: counterBaselineFor(ch.machineId),
      });
      break;
    case "modbus":
      inner = new ModbusSignalSource({
        host: cc.host,
        port: cc.port,
        unitId: cc.unitId,
        goodCountRegister: cc.goodCountRegister,
        scrapCountRegister: cc.scrapCountRegister,
        statusRegister: cc.statusRegister,
        counterBaseline: counterBaselineFor(ch.machineId),
      });
      break;
    default:
      inner = new SimulatedSignalSource();
  }

  if (ch.statusMode === "signal_presence") {
    return new SignalPresenceWatchdog(inner, ch.noSignalTimeoutSeconds * 1000);
  }
  return new ProductionGate(inner, ch.acceptProductionWhileDown);
}

function setupChannel(client: MqttClient, ch: ChannelConfig): { stop: () => void } {
  const buffer = new FileEventBuffer(`${config.bufferFilePath}.${ch.machineId}`);
  const topic = eventTopic(ch.machineId);
  const myAckTopic = ackTopic(ch.machineId);

  function toMachineEvent(reading: SignalReading): MachineEvent {
    const envelope = { machineId: ch.machineId, timestamp: clock.nowIso(), sourceEventId: randomUUID() };
    switch (reading.kind) {
      case "production_count":
        return { ...envelope, type: "production_count", result: reading.result, scrapReasonCode: reading.scrapReasonCode };
      case "machine_status":
        return { ...envelope, type: "machine_status", status: reading.status };
      case "data_gap":
        return { ...envelope, type: "data_gap", reason: reading.reason, gapSeconds: reading.gapSeconds, lostGood: reading.lostGood, lostScrap: reading.lostScrap };
    }
  }

  function publishBestEffort(event: MachineEvent): void {
    if (!client.connected) return;
    client.publish(topic, JSON.stringify(event), { qos: 1 }, (err) => {
      if (err) log.warn({ err, machineId: ch.machineId, sourceEventId: event.sourceEventId }, "publish attempt failed — will retry");
    });
  }

  function handleReading(reading: SignalReading): void {
    const event = toMachineEvent(reading);
    if (event.type === "production_count") log.debug({ event }, "part event");
    else if (event.type === "data_gap") log.warn({ machineId: ch.machineId, gap: event }, "parts were not booked (data gap) - reporting it as an event");
    else log.info({ machineId: ch.machineId, status: event.status, sourceEventId: event.sourceEventId }, "machine status changed");
    buffer.enqueue(event);
    publishBestEffort(event);
  }

  const retryTracker = new RetryTracker();
  const ackBatcher = new AckBatcher((ids) => buffer.removeMany(ids), (err) => log.error({ err, machineId: ch.machineId }, "failed to remove acknowledged events from the buffer"));

  function retryPending(): void {
    if (!client.connected) return;
    for (const event of retryTracker.select(buffer.readAll())) publishBestEffort(event);
  }

  // The channel may start while the broker is down: subscribe now if connected
  // and again on every (re)connect.
  const subscribeAcks = (): void => {
    client.subscribe(myAckTopic, (err) => {
      if (err) log.error({ err, machineId: ch.machineId }, "failed to subscribe to ack topic");
    });
  };
  if (client.connected) subscribeAcks();
  client.on("connect", subscribeAcks);
  const resetRetries = (): void => retryTracker.reset();
  client.on("connect", resetRetries);
  const onMessage = (receivedTopic: string, payload: Buffer): void => {
    if (receivedTopic !== myAckTopic) return;
    let raw: unknown;
    try {
      raw = JSON.parse(payload.toString("utf-8"));
    } catch {
      return;
    }
    const result = safeParseAck(raw);
    if (!result.success) return;
    ackBatcher.add(result.data.sourceEventId);
  };
  client.on("message", onMessage);

  const retryTimer = setInterval(retryPending, 4000);
  const source = buildSourceFromChannel(ch);
  source.start(handleReading);
  log.info({ machineId: ch.machineId, source: source.name }, "channel started");

  return {
    stop: () => {
      source.stop();
      clearInterval(retryTimer);
      client.off("connect", subscribeAcks);
      client.off("connect", resetRetries);
      client.off("message", onMessage);
      ackBatcher.flushNow(); // acknowledged events still waiting for their batch leave the buffer now
    },
  };
}

import { clockAheadMs, clockSkewWarning } from "./clock-check.js";

async function claimEdgeNode(
  token: string,
): Promise<{ sessionId: string; channels: ChannelConfig[]; settings: { catchupMaxMinutes: number }; clockAheadMs: number | null }> {
  const sentAt = Date.now();
  const res = await fetch(`${config.backendHttpUrl}/api/edge-nodes/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, clientTimeMs: sentAt, disk: await readDiskUsage(config.bufferFilePath), clientCert: await readClientCertExpiryOnce(process.env.MQTT_CLIENT_CERT) }),
    signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
  });
  if (!res.ok) {
    const errorBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ClaimHttpError(res.status, errorBody.error ?? `claim failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    sessionId: string;
    settings?: { catchupMaxMinutes?: number };
    serverTimeMs?: number;
    channels: Array<{
      machineId: string | null;
      signalSource: ChannelConfig["signalSource"];
      connectionConfig: Record<string, any>;
      statusMode: ChannelConfig["statusMode"];
      noSignalTimeoutSeconds: number;
      acceptProductionWhileDown: boolean;
    }>;
  };
  const wanted = body.settings?.catchupMaxMinutes;
  return {
    sessionId: body.sessionId,
    clockAheadMs: typeof body.serverTimeMs === "number" ? clockAheadMs(sentAt, Date.now(), body.serverTimeMs) : null,
    settings: {
      catchupMaxMinutes:
        typeof wanted === "number" && Number.isInteger(wanted) && wanted >= 0 && wanted <= 1440 ? wanted : config.catchupMaxMinutes,
    },
    channels: body.channels
      .filter((c) => !!c.machineId)
      .map((c) => ({
        machineId: c.machineId as string,
        signalSource: c.signalSource,
        connectionConfig: c.connectionConfig,
        statusMode: c.statusMode,
        noSignalTimeoutSeconds: c.noSignalTimeoutSeconds,
        acceptProductionWhileDown: c.acceptProductionWhileDown,
      })),
  };
}

import { readDiskUsage } from "./disk-usage.js";
import { readClientCertExpiryOnce } from "./client-cert.js";

/** Sends the heartbeat; returns how far the device clock is ahead of the server's (negative = behind), or null if unknown. */
async function sendHeartbeat(token: string, sessionId: string): Promise<number | null> {
  const disk = await readDiskUsage(config.bufferFilePath);
  const clientCert = await readClientCertExpiryOnce(process.env.MQTT_CLIENT_CERT);
  const sentAt = Date.now(); // the RAW device time: the backend derives the clock offset and its alert from it
  const res = await fetch(`${config.backendHttpUrl}/api/edge-nodes/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, sessionId, clientTimeMs: sentAt, disk, clientCert }),
    signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
  });
  const receivedAt = Date.now();
  if (!res.ok) throw new HeartbeatHttpError(res.status, `the backend answered the heartbeat with HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as { serverTimeMs?: unknown } | null;
  return measureAhead(sentAt, receivedAt, body?.serverTimeMs);
}

/** Gives the instance lease back on a clean shutdown, so the next start does not wait for the 90 s heartbeat timeout. */
async function releaseSession(token: string, sessionId: string): Promise<void> {
  try {
    const res = await fetch(`${config.backendHttpUrl}/api/edge-nodes/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, sessionId }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) log.warn({ status: res.status }, "could not release the edge node session");
  } catch (err) {
    log.warn({ err }, "could not release the edge node session (the next start may wait up to 90 s)");
  }
}

type ClaimData = Awaited<ReturnType<typeof claimEdgeNode>>;

const claimCache = new ClaimCache(config.claimCachePath, config.claimCacheMaxAgeMs);

/** Keeps the last claimed configuration on the device; a failed write only costs the ability to start offline. */
async function saveClaimCache(token: string, claimed: ClaimData): Promise<void> {
  try {
    await claimCache.save(token, { channels: claimed.channels as unknown as CachedClaim["channels"], settings: claimed.settings });
  } catch (err) {
    log.warn({ err }, "could not save the claim cache — an offline start will not be possible until it can be written");
  }
}

async function runRegistryMode(token: string): Promise<void> {
  let sessionId: string | null = null; // null = running without a lease (offline start)
  let channels: ChannelConfig[] = [];
  let startedOffline = false;

  let claimed: ClaimData | null = null;
  try {
    // A rejection (409: the lease of a crashed instance of this node is still fresh; 401, ...) is waited out with a backoff
    // instead of ending the process, so systemd does not restart the agent every few seconds (chaos finding 34).
    claimed = await claimWaitingOutRejection({
      claim: () => claimEdgeNode(token),
      onRejected: (err, nextInMs) =>
        log.warn(
          { err, nextInSeconds: Math.round(nextInMs / 1000) },
          "the backend rejected the claim — no channel is started; asking again (the lease of a crashed instance of this node expires after 90 s)",
        ),
    });
  } catch (err) {
    // Only "the backend cannot be reached" allows an offline start. An answer of "no" (invalid token,
    // node removed, lease held by another instance) must not be bypassed.
    if (classifyClaimFailure(err) !== "unreachable") throw err;
    const cached = await claimCache.load(token);
    if (!cached.ok) {
      log.error({ err, reason: cached.reason }, "backend unreachable and no usable cached configuration — cannot start");
      throw err;
    }
    startedOffline = true;
    channels = cached.value.channels as unknown as ChannelConfig[];
    nodeSettings.catchupMaxMinutes = cached.value.settings.catchupMaxMinutes;
    log.warn(
      { err, channelCount: channels.length, cacheAgeSeconds: Math.round((Date.now() - cached.savedAtMs) / 1000) },
      "backend unreachable — starting channels from the cached configuration WITHOUT a lease; will keep trying to claim",
    );
  }
  if (claimed) {
    sessionId = claimed.sessionId;
    channels = claimed.channels;
    // Measured before any channel starts, so the very first event already carries the corrected time.
    clock.update(claimed.clockAheadMs);
    if (claimed.clockAheadMs !== null && clockSkewWarning(claimed.clockAheadMs)) {
      log.warn({ clockAheadMs: claimed.clockAheadMs, correctionMs: clock.offset }, clockCorrectionNotice(claimed.clockAheadMs));
    }
    nodeSettings.catchupMaxMinutes = claimed.settings.catchupMaxMinutes;
    log.info({ channelCount: channels.length, catchupMaxMinutes: claimed.settings.catchupMaxMinutes }, "claimed edge node, starting channels");
    await saveClaimCache(token, claimed);
  }
  // The S7 Python bridge reads the clock correction from a file; it has to be there before the first channel starts
  // (after an offline start the correction is 0 and overwrites whatever an earlier run left behind).
  await publishClockOffset();

  const client = mqtt.connect(config.mqttUrl, { ...mqttTlsOptions(), reconnectPeriod: 2000, keepalive: 15, connectTimeout: 10_000, clientId: `edge-node-${randomUUID()}` });
  client.on("reconnect", () => log.warn("reconnecting to broker…"));
  client.on("close", () => log.warn("connection to broker closed"));
  client.on("error", (err) => log.error({ err }, "mqtt client error"));

  client.on("connect", () => log.info({ url: config.mqttUrl }, "connected to broker"));
  // The channels start at once: every event is written to the disk buffer first
  // and published when (and as soon as) the broker is connected.

  let runtimes = channels.map((ch) => setupChannel(client, ch));

  function restartChannels(reason: string): void {
    log.warn({ reason, channelCount: channels.length }, "restarting channels");
    for (const r of runtimes) r.stop();
    runtimes = channels.map((ch) => setupChannel(client, ch));
  }

  /** Applies a clock measurement from a heartbeat. No restart: the channels read the corrected clock live and the S7 bridge re-reads the file. */
  function applyMeasuredClock(aheadMs: number | null): void {
    const change = clock.update(aheadMs);
    if (!change.changed) return;
    log.warn({ aheadMs, fromMs: change.previous, toMs: change.current }, "timestamp correction changed");
    void publishClockOffset();
  }

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  function startHeartbeat(): void {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      if (!sessionId) return;
      sendHeartbeat(token, sessionId)
        .then(applyMeasuredClock)
        .catch((err) => {
          if (classifyHeartbeatFailure(err) === "lease_lost") {
            leaseLost((err as HeartbeatHttpError).status);
            return;
          }
          log.warn({ err }, "heartbeat failed — will retry next tick");
        });
    }, 30000);
  }
  if (sessionId) startHeartbeat();

  let backgroundClaim: { stop: () => void } | null = null;
  let stopping = false;

  function shutdown(exitCode: number): void {
    if (stopping) return;
    stopping = true;
    log.info("shutting down…");
    backgroundClaim?.stop();
    for (const r of runtimes) r.stop();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    setTimeout(() => process.exit(exitCode), 5000); // client.end() may never call back while offline
    const released = sessionId ? releaseSession(token, sessionId) : Promise.resolve();
    void released.finally(() => client.end(false, {}, () => process.exit(exitCode)));
  }

  let leaseRecovery = false;

  /**
   * The backend no longer accepts this node's session (HTTP 409: another instance claimed the node, or it
   * forgot the session; 401/404/400: the token is no longer valid). The channels keep running (events stay
   * buffered on disk), the agent claims again in the background; if the backend keeps refusing for 150 s
   * the node belongs to another instance and the agent stops (startLeaseClaim, onGiveUp).
   */
  function leaseLost(status: number): void {
    if (leaseRecovery || stopping) return;
    leaseRecovery = true;
    sessionId = null;
    log.warn(
      { status },
      "the backend no longer accepts this node's lease (another instance claimed the node, or the token is not valid any more) — claiming again; the channels keep running and the events stay buffered",
    );
    startLeaseClaim("still running; the lease is held by someone else or is not free yet", "claimed edge node again after the lease was lost — lease adopted");
  }

  function startLeaseClaim(why: string, adopted: string): void {
    backgroundClaim = startBackgroundClaim<ClaimData>({
      claim: () => claimEdgeNode(token),
      onAttemptFailed: (kind, err, nextInMs) =>
        log.warn({ err, kind, nextInSeconds: Math.round(nextInMs / 1000) }, `background claim failed — ${why}`),
      onClaimed: async (c) => {
        if (c.clockAheadMs !== null && clockSkewWarning(c.clockAheadMs)) {
          log.warn({ clockAheadMs: c.clockAheadMs }, clockCorrectionNotice(c.clockAheadMs));
        }
        if (clock.update(c.clockAheadMs).changed) await publishClockOffset();
        nodeSettings.catchupMaxMinutes = c.settings.catchupMaxMinutes;
        const configChanged = !sameChannels(channels, c.channels);
        if (configChanged) {
          log.warn({ before: channels.length, after: c.channels.length }, "channel configuration changed while the node was offline");
          channels = c.channels;
        }
        if (configChanged) restartChannels("the channel configuration changed while offline");
        sessionId = c.sessionId;
        leaseRecovery = false;
        startHeartbeat();
        log.info({ channelCount: channels.length }, adopted);
        await saveClaimCache(token, c);
      },
      onGiveUp: (reason) => {
        log.error({ reason }, "the backend does not give this node its lease — stopping channels (another instance probably owns the node); buffered events stay on disk");
        shutdown(1);
      },
    });
  }

  if (startedOffline) startLeaseClaim("still running from the cached configuration", "claimed edge node after an offline start — lease adopted");

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

// ============================================================
// Belépési pont
// ============================================================

const startMode = decideStartMode(config.edgeNodeToken, legacyFlagFromEnv(process.env.EDGE_AGENT_LEGACY));
if (startMode.mode === "registry") {
  runRegistryMode(startMode.token).catch((err) => {
    log.error({ err }, "failed to start in registry mode");
    process.exit(1);
  });
} else if (startMode.mode === "legacy") {
  log.warn("EDGE_AGENT_LEGACY=true - legacy single-machine mode (no registry, no heartbeat); the machine id comes from MACHINE_ID");
  runLegacyMode();
} else {
  log.error(startMode.reason);
  process.exit(EXIT_CONFIG);
}
