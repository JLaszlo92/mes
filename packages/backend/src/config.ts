export const config = {
  mqttUrl: process.env.MQTT_URL ?? "mqtt://127.0.0.1:1883",
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl:
    process.env.DATABASE_URL ?? "postgresql://mes:mes_dev_password@127.0.0.1:5432/mes_dev",
};
