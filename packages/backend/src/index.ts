import { config } from "./config.js";
import { runMigrations } from "./migrate.js";
import { buildServer } from "./server.js";
import { startMqttSubscriber } from "./mqtt-subscriber.js";
import { startAlertEvaluator } from "./alert-evaluator.js";
import { startPreventiveMaintenanceEvaluator } from "./preventive-maintenance-evaluator.js";
import { startDowntimeEvaluator } from "./downtime-periods-evaluator.js";
import { startWorkOrderAutoCompleteEvaluator } from "./work-order-auto-complete-evaluator.js";
import { stateStore } from "./state.js";
import { startProductionRollupEvaluator } from "./production-rollup-evaluator.js";
import { startOffShiftEvaluator } from "./off-shift-evaluator.js";
import { startBackupHealthEvaluator } from "./backup-health-evaluator.js";
import { startStatusRollupEvaluator } from "./status-rollup-evaluator.js";
import { ensureDatabaseTimezone } from "./db.js";
import { startRawEventRetentionEvaluator } from "./raw-event-retention-evaluator.js";
import { startLicenseEvaluator } from "./license-service.js";
import { startCertHealthEvaluator } from "./cert-health-evaluator.js";

async function main(): Promise<void> {
  await runMigrations();

  // Induláskor visszatöltjük minden gép legutóbbi ismert állapotát a
  // Postgres-ből — enélkül minden gép hamisan "idle"-nek látszana a
  // dashboardon, amíg a következő valódi machine_status esemény meg nem
  // érkezik.
  await stateStore.rehydrateStatuses();

  const app = await buildServer();
  startMqttSubscriber(app.log);

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`backend listening on http://${config.host}:${config.port}`);

  void ensureDatabaseTimezone(app.log);
  
  startAlertEvaluator(app.log);
  startPreventiveMaintenanceEvaluator(app.log);
  startDowntimeEvaluator(app.log);
  startWorkOrderAutoCompleteEvaluator(app.log);
  startProductionRollupEvaluator(app.log);
  startStatusRollupEvaluator(app.log);
  startRawEventRetentionEvaluator(app.log);
  startOffShiftEvaluator(app.log);
  startBackupHealthEvaluator(app.log);
  startLicenseEvaluator(app.log);
  startCertHealthEvaluator(app.log);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});