import mqtt from "mqtt";
import { ackTopic, EVENT_TOPIC_WILDCARD, safeParseMachineEvent } from "@mes/shared";
import type { FastifyBaseLogger } from "fastify";
import { config } from "./config.js";
import { insertEvent } from "./events-repository.js";
import { publishToHub } from "./hub.js";
import { stateStore } from "./state.js";

export function startMqttSubscriber(log: FastifyBaseLogger): mqtt.MqttClient {
  // A stable clientId + clean:false gives this client a persistent broker
  // session: on reconnect, the broker restores its subscriptions as part
  // of the CONNECT handshake itself, rather than this client having to
  // send a fresh SUBSCRIBE and hope no publisher gets there first. That
  // closes most of the reconnect race window; the application-level ack
  // below (see handleMessage) is what closes the rest of it — including
  // the broker itself restarting, which drops persisted sessions too.
  const client = mqtt.connect(config.mqttUrl, {
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
    const outcome = await insertEvent(event);
    if (outcome === "duplicate") {
      log.debug({ sourceEventId: event.sourceEventId }, "duplicate event ignored");
    } else {
      stateStore.applyEvent(event);
      publishToHub(event);
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
