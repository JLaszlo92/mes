import { computeWorkOrderProgress, updateWorkOrder, findAutoCompleteCandidates } from "./work-orders-repository.js";
import { generateLotForWorkOrder } from "./lots-repository.js";
import { recordAuditEvent } from "./audit-repository.js";

/**
 * Ellenőrzi (egy adott gépre, vagy ha nincs megadva, mindegyikre), hogy
 * valamelyik "auto" lezárási módú, folyamatban lévő munkarendelés elérte-e
 * a célmennyiséget, és ha igen, lezárja + genealógiát generál hozzá.
 * Ezt hívja mind az azonnali, esemény-vezérelt ellenőrzés (mqtt-subscriber),
 * mind a periodikus háttér-kiértékelő (biztonsági háló).
 */
export async function checkAndAutoCompleteWorkOrders(machineId?: string): Promise<void> {
  const candidates = await findAutoCompleteCandidates(machineId);
  for (const candidate of candidates) {
    const progress = await computeWorkOrderProgress(candidate.id, candidate.quantity, candidate.countOverproduction);
    if (!progress.targetReached) continue;

    await updateWorkOrder(candidate.id, { status: "completed" });
    await generateLotForWorkOrder(candidate.id);
    await recordAuditEvent({
      actorId: null,
      actorEmail: "system",
      action: "work_order_auto_completed",
      target: candidate.id,
      details: { goodCount: progress.goodCount, quantity: candidate.quantity },
      ipAddress: null,
    });
  }
}