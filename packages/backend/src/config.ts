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

/**
 * A gyár helyi időzónája (IANA név, pl. "Europe/Budapest"). A műszakhatárok
 * (06:00, 14:00, 22:00), a naptári napok és minden "hány óra van" döntés
 * ebben értendő. Korábban sehol nem volt megadva, így a backend és az
 * adatbázis is UTC-ben értelmezte a műszakokat — nyáron 2, télen 1 óra
 * eltolással. Egyetlen forrás: a Node folyamat (process.env.TZ) és minden
 * adatbázis-kapcsolat (db.ts) ezt kapja. Több telephelynél ez telephelyenként
 * kell majd (PRD Phase 2).
 */
function timezoneFromEnv(): string {
  const value = process.env.MES_TIMEZONE ?? "Europe/Budapest";
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
  } catch {
    throw new Error(`MES_TIMEZONE "${value}" is not a valid IANA time zone (e.g. "Europe/Budapest")`);
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

const timezone = timezoneFromEnv();
// A Node folyamat helyi ideje is ez legyen, hogy a JS-ben végzett nap- és
// óraszámítások (Date#getHours, setHours, getDay…) ugyanúgy értelmezzenek,
// mint az adatbázis.
process.env.TZ = timezone;

export const config = {
  timezone,
  mqttUrl: process.env.MQTT_URL ?? "mqtt://127.0.0.1:1883",
  port: portFromEnv(),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: databaseUrlFromEnv(),
};
