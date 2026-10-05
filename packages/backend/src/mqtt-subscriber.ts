import { mqttTlsOptions } from "./mqtt-tls.js";
import mqtt from "mqtt";
import { ackTopic, EVENT_TOPIC_WILDCARD, safeParseMachineEvent } from "@mes/shared";
import type { FastifyBaseLogger } from "fastify";
import { config } from "./config.js";
import { insertEvent } from "./events-repository.js";
import { publishToHub } from "./hub.js";
import { stateStore } from "./state.js";
import { checkAndAutoCompleteWorkOrders } from "./work-order-completion-service.js";
import { pool } from "./db.js";
import { createMachineRegistryCache } from "./machine-registry-cache.js";

// Events are only accepted for machines that exist in the registry. An
// unknown machine id used to be stored anyway, and its hourly rollup then
// failed on the machines foreign key - for every machine. The cache keeps
// the check off the hot path (see machine-registry-cache.ts).
const registeredMachines = createMachineRegistryCache(async () => {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM machines");
  return rows.map((r) => r.id);
});

// One warning per machine id per 5 minutes, with the number of events
// dropped meanwhile, so a misconfigured (or malicious) sender cannot flood
// the log.
const UNKNOWN_WARN_INTERVAL_MS = 5 * 60_000;
const unknownSeen = new Map<string, { lastWarn: number; dropped: number }>();

function noteUnknownMachine(log: FastifyBaseLogger, machineId: string): void {
  const now = Date.now();
  if (unknownSeen.size > 1000) unknownSeen.clear(); // bound memory against random ids
  const entry = unknownSeen.get(machineId) ?? { lastWarn: 0, dropped: 0 };
  entry.dropped += 1;
  if (now - entry.lastWarn >= UNKNOWN_WARN_INTERVAL_MS) {
    log.warn(
      { machineId, dropped: entry.dropped },
      "dropped events from a machine id that is not registered",
    );
    entry.lastWarn = now;
    entry.dropped = 0;
  }
  unknownSeen.set(machineId, entry);
}

export function startMqttSubscriber(log: FastifyBaseLogger): mqtt.MqttClient {
  // A stable clientId + clean:false gives this client a persistent broker
  // session: on reconnect, the broker restores its subscriptions as part
  // of the CONNECT handshake itself, rather than this client having to
  // send a fresh SUBSCRIBE and hope no publisher gets there first. That
  // closes most of the reconnect race window; the application-level ack
  // below (see handleMessage) is what closes the rest of it — including
  // the broker itself restarting, which drops persisted sessions too.
  const client = mqtt.connect(config.mqttUrl, {
    ...mqttTlsOptions(),
    reconnectPeriod: 2000,
    clientId: "backend-ingest",
    clean: false,
  });

  client.on("connect", () => {
    log.info({ url: config.mqttUrl }, "mqtt subscriber connected");
    client.subscribe(EVENT_TOPIC_WILDCARD, (err) => {
      if (err) log.error({ err }, "failed to subscribe to event topic");
    });
  });

  client.on("reconnect", () => log.warn("mqtt subscriber reconnecting…"));
  client.on("close", () => log.warn("mqtt subscriber connection closed"));
  client.on("error", (err) => log.error({ err }, "mqtt subscriber error"));

  client.on("message", (_topic, payload) => {
    void handleMessage(client, payload, log);
  });

  return client;
}

async function handleMessage(
  client: mqtt.MqttClient,
  payload: Buffer,
  log: FastifyBaseLogger,
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(payload.toString("utf-8"));
  } catch {
    log.warn({ payload: payload.toString("utf-8") }, "dropped non-JSON message");
    return;
  }

  const result = safeParseMachineEvent(raw);
  if (!result.success) {
    log.warn({ raw, issues: result.error.issues }, "dropped message failing schema validation");
    return;
  }
  const event = result.data;

  try {
    if (!(await registeredMachines.isRegistered(event.machineId))) {
      noteUnknownMachine(log, event.machineId);
      // Acked on purpose: the edge agent republishes every unacked event
      // every few seconds, so a never-registered machine would otherwise be
      // resent forever while its buffer only grows.
      client.publish(
        ackTopic(event.machineId),
        JSON.stringify({ sourceEventId: event.sourceEventId }),
        { qos: 1 },
      );
      return;
    }
  } catch (err) {
    log.error({ err }, "machine registry lookup failed — NOT acking, edge agent will retry");
    return;
  }

  try {
    const outcome = await insertEvent(event, (info) =>
      log.warn({ machineId: event.machineId, sourceEventId: event.sourceEventId, ...info }, "event timestamp is in the future — stored with the receive time"),
    );
    if (outcome === "duplicate") {
      log.debug({ sourceEventId: event.sourceEventId }, "duplicate event ignored");
    } else {
      stateStore.applyEvent(event);
      publishToHub(event);
      // Azonnali (nem 30-60mp-es pollozásra váró) ellenőrzés: elérte-e ez a
      // gép valamelyik "auto" munkarendelésének célmennyiségét. Fire-and-
      // forget, hogy ne lassítsa az ack-küldést.
      if (event.type === "production_count" && event.result === "good") {
        void checkAndAutoCompleteWorkOrders(event.machineId).catch((err) =>
          log.error({ err, machineId: event.machineId }, "auto-complete check failed"),
        );
      }
    }
  } catch (err) {
    log.error({ err }, "failed to persist event — NOT acking, edge agent will retry");
    return;
  }

  // Either way (freshly inserted or already had it), the event is durably
  // stored — safe to tell the edge agent it can stop retrying this one.
  client.publish(
    ackTopic(event.machineId),
    JSON.stringify({ sourceEventId: event.sourceEventId }),
    { qos: 1 },
  );
}
