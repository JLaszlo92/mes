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

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

// ============================================================
// RÉGI, EGY-GÉPES MÓD — env változókból, változatlanul megtartva
// visszafelé kompatibilitás miatt, amíg a meglévő szolgáltatások át
// nem lettek migrálva az edge-node regisztrációra.
// ============================================================

// Per-node settings. In registry mode the backend delivers them on claim; the
// environment value is the fallback (legacy mode, older backends).
const nodeSettings = { catchupMaxMinutes: config.catchupMaxMinutes };

function counterStateFile(machineId: string): string {
  return joinPath(config.counterStateDir, `counters.${machineId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

function counterBaselineFor(machineId: string): CounterBaseline {
  return new CounterBaseline({
    machineId,
    filePath: counterStateFile(machineId),
    maxAgeMs: nodeSettings.catchupMaxMinutes * 60_000,
    log: { info: (obj, msg) => log.info(obj, msg), warn: (obj, msg) => log.warn(obj, msg) },
  });
}

function s7CatchupEnv(machineId: string): Record<string, string> {
  return {
    COUNTER_STATE_FILE: counterStateFile(machineId),
    CATCHUP_MAX_AGE_SECONDS: String(nodeSettings.catchupMaxMinutes * 60),
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
    const envelope = { machineId: config.machineId, timestamp: new Date().toISOString(), sourceEventId: randomUUID() };
    switch (reading.kind) {
      case "production_count":
        return { ...envelope, type: "production_count", result: reading.result, scrapReasonCode: reading.scrapReasonCode };
      case "machine_status":
        return { ...envelope, type: "machine_status", status: reading.status };
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
    const envelope = { machineId: ch.machineId, timestamp: new Date().toISOString(), sourceEventId: randomUUID() };
    switch (reading.kind) {
      case "production_count":
        return { ...envelope, type: "production_count", result: reading.result, scrapReasonCode: reading.scrapReasonCode };
      case "machine_status":
        return { ...envelope, type: "machine_status", status: reading.status };
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
  client.on("connect", () => retryTracker.reset());
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
  const source = buildSourceFromChannel(ch);
  source.start(handleReading);
  log.info({ machineId: ch.machineId, source: source.name }, "channel started");

  return {
    stop: () => {
      source.stop();
      clearInterval(retryTimer);
      client.off("connect", subscribeAcks);
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

async function sendHeartbeat(token: string, sessionId: string): Promise<void> {
  await fetch(`${config.backendHttpUrl}/api/edge-nodes/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, sessionId, clientTimeMs: Date.now(), disk: await readDiskUsage(config.bufferFilePath), clientCert: await readClientCertExpiryOnce(process.env.MQTT_CLIENT_CERT) }),
  });
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
    claimed = await claimEdgeNode(token);
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
    const skew = clockSkewWarning(claimed.clockAheadMs);
    if (skew) log.error({ clockAheadMs: claimed.clockAheadMs }, skew);
    nodeSettings.catchupMaxMinutes = claimed.settings.catchupMaxMinutes;
    log.info({ channelCount: channels.length, catchupMaxMinutes: claimed.settings.catchupMaxMinutes }, "claimed edge node, starting channels");
    await saveClaimCache(token, claimed);
  }

  const client = mqtt.connect(config.mqttUrl, { ...mqttTlsOptions(), reconnectPeriod: 2000, keepalive: 15, connectTimeout: 10_000, clientId: `edge-node-${randomUUID()}` });
  client.on("reconnect", () => log.warn("reconnecting to broker…"));
  client.on("close", () => log.warn("connection to broker closed"));
  client.on("error", (err) => log.error({ err }, "mqtt client error"));

  client.on("connect", () => log.info({ url: config.mqttUrl }, "connected to broker"));
  // The channels start at once: every event is written to the disk buffer first
  // and published when (and as soon as) the broker is connected.

  let runtimes = channels.map((ch) => setupChannel(client, ch));

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  function startHeartbeat(): void {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      if (!sessionId) return;
      sendHeartbeat(token, sessionId).catch((err) => log.warn({ err }, "heartbeat failed — will retry next tick"));
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

  if (startedOffline) {
    backgroundClaim = startBackgroundClaim<ClaimData>({
      claim: () => claimEdgeNode(token),
      onAttemptFailed: (kind, err, nextInMs) =>
        log.warn({ err, kind, nextInSeconds: Math.round(nextInMs / 1000) }, "background claim failed — still running from the cached configuration"),
      onClaimed: async (c) => {
        const skew = clockSkewWarning(c.clockAheadMs);
        if (skew) log.error({ clockAheadMs: c.clockAheadMs }, skew);
        nodeSettings.catchupMaxMinutes = c.settings.catchupMaxMinutes;
        if (!sameChannels(channels, c.channels)) {
          log.warn({ before: channels.length, after: c.channels.length }, "channel configuration changed while the node was offline — restarting channels");
          for (const r of runtimes) r.stop();
          channels = c.channels;
          runtimes = channels.map((ch) => setupChannel(client, ch));
        }
        sessionId = c.sessionId;
        startHeartbeat();
        log.info({ channelCount: channels.length }, "claimed edge node after an offline start — lease adopted");
        await saveClaimCache(token, c);
      },
      onGiveUp: (reason) => {
        log.error({ reason }, "the backend does not give this node its lease — stopping channels (another instance probably owns the node); buffered events stay on disk");
        shutdown(1);
      },
    });
  }

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
