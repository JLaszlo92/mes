import { config } from "./config.js";
import { runMigrations } from "./migrate.js";
import { buildServer } from "./server.js";
import { startMqttSubscriber } from "./mqtt-subscriber.js";

async function main(): Promise<void> {
  await runMigrations();

  const app = await buildServer();
  startMqttSubscriber(app.log);

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`backend listening on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
