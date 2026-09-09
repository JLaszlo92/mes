import { randomUUID } from "node:crypto";
import mqtt from "mqtt";
import pino from "pino";
import { ackTopic, eventTopic, safeParseAck, type MachineEvent } from "@mes/shared";
import { config } from "./config.js";
import { FileEventBuffer } from "./buffer.js";
import { GpioSignalSource } from "./signal-sources/GpioSignalSource.js";
import { S7SignalSource } from "./signal-sources/S7SignalSource.js";
import { SimulatedSignalSource } from "./signal-sources/SimulatedSignalSource.js";
import type { SignalReading, SignalSource } from "./signal-sources/SignalSource.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

const buffer = new FileEventBuffer(config.bufferFilePath);
const topic = eventTopic(config.machineId);
const myAckTopic = ackTopic(config.machineId);

// SIGNAL_SOURCE points this agent at a real machine connection instead of
// the in-process simulator — "s7" polls a Siemens S7 PLC (or its
// simulator) over the network with no wiring at all (docs/pi-test-rig-s7-
// mode.md, the recommended first pass), "gpio" reads real discrete I/O on
// the physical 3-Pi rig (docs/pi-test-rig.md) or a real machine later.
// Either way this is the only place that decision gets made; nothing
// downstream (buffering, MQTT, the backend, the dashboard) knows or cares
// which.
function buildSignalSource(): SignalSource {
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
    default:
      return new SimulatedSignalSource();
  }
}

const source: SignalSource = buildSignalSource();

/**
 * Delivery model: every event is written to the durable buffer the moment
 * it's generated — that write is the only thing that has to succeed for
 * the reading to be safe. Publishing is then attempted immediately (for
 * low latency in the normal case) AND retried on a fixed interval for
 * whatever is still sitting in the buffer. An event only leaves the buffer
 * when the backend's application-level ack for its sourceEventId arrives
 * (see mqtt-subscriber.ts on the backend). This is deliberately more
 * paranoid than trusting MQTT's own QoS1 ack: that only proves the broker
 * received the publish, not that the backend was actually subscribed and
 * processed it — see ROADMAP.md M0 verification notes for the reconnect
 * race this caught in practice.
 */

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

  // The buffer write is the durability guarantee. Everything after this is
  // best-effort delivery of what's already safely on disk.
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
  // Whatever is still unacked from before this (re)connect gets a
  // republish attempt right away, in addition to the periodic sweep.
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
