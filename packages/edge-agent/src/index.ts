import { randomUUID } from "node:crypto";
import mqtt from "mqtt";
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

const buffer = new FileEventBuffer(config.bufferFilePath);
const topic = eventTopic(config.machineId);
const myAckTopic = ackTopic(config.machineId);

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

function buildSignalSource(): SignalSource {
  const inner = buildInnerSignalSource();
  if (config.statusMode === "signal_presence") {
    return new SignalPresenceWatchdog(inner, config.noSignalTimeoutMs);
  }
  return new ProductionGate(inner, config.acceptProductionWhileDown);
}

const source: SignalSource = buildSignalSource();

function toMachineEvent(reading: SignalReading): MachineEvent {
  const envelope = {
    machineId: config.machineId,
    timestamp: new Date().toISOString(),
    sourceEventId: randomUUID(),
  };
  switch (reading.kind) {
    case "production_count":
      return {
        ...envelope,
        type: "production_count",
        result: reading.result,
        scrapReasonCode: reading.scrapReasonCode,
      };
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

  if (event.type === "production_count") {
    log.debug({ event }, "part event");
  } else {
    log.info({ status: event.status, sourceEventId: event.sourceEventId }, "machine status changed");
  }

  buffer.enqueue(event);
  publishBestEffort(event);
}

function retryPending(): void {
  const pending = buffer.readAll();
  if (pending.length > 0) {
    log.debug({ count: pending.length }, "retry sweep — republishing unacked events");
  }
  for (const event of pending) {
    publishBestEffort(event);
  }
}

const client = mqtt.connect(config.mqttUrl, {
  reconnectPeriod: 2000,
  clientId: `edge-agent-${config.machineId}`,
});

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

log.info({ machineId: config.machineId, topic, source: source.name }, "edge agent started");

function shutdown(): void {
  log.info("shutting down…");
  source.stop();
  clearInterval(retryTimer);
  client.end(false, {}, () => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);