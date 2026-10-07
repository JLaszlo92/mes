import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Expiry of the device's MQTT client certificate (the one the connection uses). */
export interface ClientCertReport {
  expiresAtMs: number;
}

/**
 * Reads the expiry (`notAfter`) of the first certificate in the PEM file at
 * `certPath`. Never throws: no path, an unreadable file or something that is not
 * a certificate only means the figure is left out of this claim or heartbeat.
 */
export async function readClientCertExpiry(certPath: string | undefined): Promise<ClientCertReport | undefined> {
  if (!certPath) return undefined;
  try {
    const cert = new X509Certificate(await readFile(certPath));
    const expiresAtMs = Date.parse(cert.validTo);
    return Number.isFinite(expiresAtMs) ? { expiresAtMs } : undefined;
  } catch {
    return undefined;
  }
}

let cached: Promise<ClientCertReport | undefined> | undefined;

/**
 * Read once per process: the MQTT connection keeps the certificate it was
 * started with, so after a renewal on disk the report must keep saying what is
 * in use until the agent restarts with the new file.
 */
export function readClientCertExpiryOnce(certPath: string | undefined): Promise<ClientCertReport | undefined> {
  cached ??= readClientCertExpiry(certPath);
  return cached;
}
