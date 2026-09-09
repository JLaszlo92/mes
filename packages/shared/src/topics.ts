/**
 * MQTT topic naming convention. Centralized here so the edge agent (which
 * publishes) and the backend (which subscribes) can never drift apart on
 * the topic shape.
 */

export function eventTopic(machineId: string): string {
  return `mes/machines/${machineId}/events`;
}

/** Subscribe with this to receive events from every connected machine. */
export const EVENT_TOPIC_WILDCARD = "mes/machines/+/events";

/** Extracts the machineId out of a concrete (non-wildcard) topic string. */
export function machineIdFromTopic(topic: string): string | null {
  const match = topic.match(/^mes\/machines\/([^/]+)\/events$/);
  return match?.[1] ?? null;
}

/**
 * Application-level acknowledgment channel, published by the backend once
 * an event is durably persisted. This exists because MQTT's own QoS1 ack
 * only proves the *broker* received a publish — not that any subscriber
 * (the backend) was actually subscribed and received it yet. Right after a
 * reconnect, a publisher can race ahead of a subscriber's re-subscription
 * and have messages silently dropped by the broker for lack of a matching
 * subscription. See edge-agent/src/index.ts for the retry-until-acked loop
 * this enables.
 */
export function ackTopic(machineId: string): string {
  return `mes/machines/${machineId}/acks`;
}
