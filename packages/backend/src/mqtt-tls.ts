import { readFileSync } from "node:fs";

/**
 * Extra TLS options for mqtts:// connections.
 * MQTT_CA_FILE = path to the internal CA certificate (PEM). Unset = no change.
 * A missing/unreadable file throws at startup on purpose.
 */
export function mqttTlsOptions(): { ca?: Buffer } {
  const file = process.env.MQTT_CA_FILE;
  return file ? { ca: readFileSync(file) } : {};
}
