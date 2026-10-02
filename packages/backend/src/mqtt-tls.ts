import { readFileSync } from "node:fs";

/**
 * Extra TLS options for mqtts:// connections.
 *   MQTT_CA_FILE     CA that signed the broker's certificate (PEM)
 *   MQTT_CLIENT_CERT this device's certificate (PEM), issued by the device CA
 *   MQTT_CLIENT_KEY  its private key (PEM)
 * The client certificate and key must be set together. Anything unset means
 * no change. A missing/unreadable file throws at startup on purpose.
 */
export function mqttTlsOptions(): { ca?: Buffer; cert?: Buffer; key?: Buffer } {
  const caFile = process.env.MQTT_CA_FILE;
  const certFile = process.env.MQTT_CLIENT_CERT;
  const keyFile = process.env.MQTT_CLIENT_KEY;
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new Error("MQTT_CLIENT_CERT and MQTT_CLIENT_KEY must be set together");
  }
  return {
    ...(caFile ? { ca: readFileSync(caFile) } : {}),
    ...(certFile && keyFile
      ? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
      : {}),
  };
}
