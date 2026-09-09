import { EventEmitter } from "node:events";
import type { MachineEvent } from "@mes/shared";

/**
 * Decouples the MQTT subscriber (which produces events) from the WebSocket
 * route (which consumes them) so neither module has to import the other
 * directly.
 */
export const eventHub = new EventEmitter();
export const MACHINE_EVENT = "machine-event";

export function publishToHub(event: MachineEvent): void {
  eventHub.emit(MACHINE_EVENT, event);
}
