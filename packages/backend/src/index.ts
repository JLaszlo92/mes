import { config } from "./config.js";
import { runMigrations } from "./migrate.js";
import { buildServer } from "./server.js";
import { startMqttSubscriber } from "./mqtt-subscriber.js";
import { startAlertEvaluator } from "./alert-evaluator.js";
import { startPreventiveMaintenanceEvaluator } from "./preventive-maintenance-evaluator.js";
import { startDowntimeEvaluator } from "./downtime-periods-evaluator.js";

async function main(): Promise<void> {
  await runMigrations();

  const app = await buildServer();
  startMqttSubscriber(app.log);
  startAlertEvaluator(app.log);

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`backend listening on http://${config.host}:${config.port}`);

  startAlertEvaluator(app.log);
  startPreventiveMaintenanceEvaluator(app.log);
  startDowntimeEvaluator(app.log);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
