/**
 * Futásidejű konfiguráció környezeti változókból.
 *
 * A DATABASE_URL kötelező, nincs alapértelmezett értéke: a kódban nem lehet
 * beégetett jelszó (PRD 8.3), és egy hiányzó beállítás induláskor, egyértelmű
 * hibával derüljön ki, ne egy rejtélyes csatlakozási hibaként egy nem létező
 * fejlesztői adatbázison. Éles környezetben: /etc/mes/backend.env
 * (EnvironmentFile= a mes-backend.service-ben).
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set — configure it in the environment (production: /etc/mes/backend.env)`);
  }
  return value;
}

function databaseUrlFromEnv(): string {
  const value = requireEnv("DATABASE_URL");
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    // Az értéket szándékosan nem írjuk ki: jelszót tartalmaz.
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error(`DATABASE_URL must use the postgres:// or postgresql:// scheme (got "${protocol}")`);
  }
  return value;
}

function portFromEnv(): number {
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535 (got "${process.env.PORT}")`);
  }
  return port;
}

export const config = {
  mqttUrl: process.env.MQTT_URL ?? "mqtt://127.0.0.1:1883",
  port: portFromEnv(),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: databaseUrlFromEnv(),
};
