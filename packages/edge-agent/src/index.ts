import { randomUUID } from "node:crypto";
import mqtt, { type MqttClient } from "mqtt";
import pino from "pino";
import { ackTopic, eventTopic, safeParseAck, type MachineEvent } from "@mes/shared";
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

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

// ============================================================
// RÉGI, EGY-GÉPES MÓD — env változókból, változatlanul megtartva
// visszafelé kompatibilitás miatt, amíg a meglévő szolgáltatások át
// nem lettek migrálva az edge-node regisztrációra.
// ============================================================

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
        },
      });
    case "opcua":
      return new OpcUaSignalSource({
        endpointUrl: config.opcua.endpointUrl,
        goodCountNodeId: config.opcua.goodCountNodeId,
        scrapCountNodeId: config.opcua.scrapCountNodeId,
        statusNodeId: config.opcua.statusNodeId,
        pollIntervalMs: config.opcua.pollIntervalMs ? parseInt(config.opcua.pollIntervalMs, 10) : undefined,
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

  function retryPending(): void {
    const pending = buffer.readAll();
    if (pending.length > 0) log.debug({ count: pending.length }, "retry sweep — republishing unacked events");
    for (const event of pending) publishBestEffort(event);
  }

  const client = mqtt.connect(config.mqttUrl, { reconnectPeriod: 2000, clientId: `edge-agent-${config.machineId}` });

  client.on("connect", () => {
    log.info({ url: config.mqttUrl }, "connected to broker");
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
    buffer.remove(result.data.sourceEventId);
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
        },
      });
      break;
    case "opcua":
      inner = new OpcUaSignalSource({
        endpointUrl: cc.endpointUrl,
        goodCountNodeId: cc.goodCountNodeId,
        scrapCountNodeId: cc.scrapCountNodeId,
        statusNodeId: cc.statusNodeId,
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

  function retryPending(): void {
    for (const event of buffer.readAll()) publishBestEffort(event);
  }

  client.subscribe(myAckTopic, (err) => {
    if (err) log.error({ err, machineId: ch.machineId }, "failed to subscribe to ack topic");
  });
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
    buffer.remove(result.data.sourceEventId);
  });

  const retryTimer = setInterval(retryPending, 4000);
  const source = buildSourceFromChannel(ch);
  source.start(handleReading);
  log.info({ machineId: ch.machineId, source: source.name }, "channel started");

  return {
    stop: () => {
      source.stop();
      clearInterval(retryTimer);
    },
  };
}

async function claimEdgeNode(token: string): Promise<{ sessionId: string; channels: ChannelConfig[] }> {
  const res = await fetch(`${config.backendHttpUrl}/api/edge-nodes/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const errorBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(errorBody.error ?? `claim failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    sessionId: string;
    channels: Array<{
      machineId: string | null;
      signalSource: ChannelConfig["signalSource"];
      connectionConfig: Record<string, any>;
      statusMode: ChannelConfig["statusMode"];
      noSignalTimeoutSeconds: number;
      acceptProductionWhileDown: boolean;
    }>;
  };
  return {
    sessionId: body.sessionId,
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

async function sendHeartbeat(token: string, sessionId: string): Promise<void> {
  await fetch(`${config.backendHttpUrl}/api/edge-nodes/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, sessionId }),
  });
}

async function runRegistryMode(token: string): Promise<void> {
  const { sessionId, channels } = await claimEdgeNode(token);
  log.info({ channelCount: channels.length }, "claimed edge node, starting channels");

  const client = mqtt.connect(config.mqttUrl, { reconnectPeriod: 2000, clientId: `edge-node-${randomUUID()}` });
  client.on("reconnect", () => log.warn("reconnecting to broker…"));
  client.on("close", () => log.warn("connection to broker closed"));
  client.on("error", (err) => log.error({ err }, "mqtt client error"));

  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  log.info({ url: config.mqttUrl }, "connected to broker");

  const runtimes = channels.map((ch) => setupChannel(client, ch));

  const heartbeatTimer = setInterval(() => {
    sendHeartbeat(token, sessionId).catch((err) => log.warn({ err }, "heartbeat failed — will retry next tick"));
  }, 30000);

  function shutdown(): void {
    log.info("shutting down…");
    for (const r of runtimes) r.stop();
    clearInterval(heartbeatTimer);
    client.end(false, {}, () => process.exit(0));
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ============================================================
// Belépési pont
// ============================================================

if (config.edgeNodeToken) {
  runRegistryMode(config.edgeNodeToken).catch((err) => {
    log.error({ err }, "failed to start in registry mode");
    process.exit(1);
  });
} else {
  runLegacyMode();
}