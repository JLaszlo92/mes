import { pool } from "./db.js";
import { createFaultReport } from "./fault-reports-repository.js";

export interface DowntimePeriod {
  id: string;
  machineId: string;
  machineName: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  faultReportId: string | null;
}

type Row = {
  id: string;
  machine_id: string;
  machine_name: string;
  started_at: string;
  ended_at: string;
  duration_seconds: string;
  fault_report_id: string | null;
};

function toDowntimePeriod(row: Row): DowntimePeriod {
  return {
    id: row.id,
    machineId: row.machine_id,
    machineName: row.machine_name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: Number(row.duration_seconds),
    faultReportId: row.fault_report_id,
  };
}

/**
 * Magyarázatra váró leállások: csak a gép mikroleállási küszöbét
 * (machines.micro_stop_threshold_seconds, sql/034) elérők. A rövidebbek
 * mikroleállások — azok a getDowntimeSummary-ben, összesítve látszanak.
 */
export async function listUnexplainedDowntimePeriods(machineId?: string): Promise<DowntimePeriod[]> {
  const params: unknown[] = [];
  let where = "dp.fault_report_id IS NULL AND dp.duration_seconds >= m.micro_stop_threshold_seconds";
  if (machineId) {
    params.push(machineId);
    where += ` AND dp.machine_id = $${params.length}`;
  }
  const result = await pool.query<Row>(
    `SELECT dp.*, m.name AS machine_name
     FROM downtime_periods dp
     JOIN machines m ON m.id = dp.machine_id
     WHERE ${where}
     ORDER BY dp.started_at DESC
     LIMIT 100`,
    params,
  );
  return result.rows.map(toDowntimePeriod);
}

export interface DowntimeSummary {
  machineId: string;
  machineName: string;
  microStopThresholdSeconds: number;
  stops: number;
  stopSeconds: number;
  microStops: number;
  microStopSeconds: number;
  unexplained: number;
}

/** Gépenkénti összesítő az utolsó `hours` órában lezárult leállásokról. */
export async function getDowntimeSummary(hours: number): Promise<DowntimeSummary[]> {
  const result = await pool.query<{
    machine_id: string;
    machine_name: string;
    threshold: number;
    stops: string;
    stop_seconds: string;
    micro_stops: string;
    micro_stop_seconds: string;
    unexplained: string;
  }>(
    `SELECT m.id AS machine_id, m.name AS machine_name, m.micro_stop_threshold_seconds AS threshold,
            count(dp.id) FILTER (WHERE dp.duration_seconds >= m.micro_stop_threshold_seconds) AS stops,
            COALESCE(sum(dp.duration_seconds) FILTER (WHERE dp.duration_seconds >= m.micro_stop_threshold_seconds), 0) AS stop_seconds,
            count(dp.id) FILTER (WHERE dp.duration_seconds < m.micro_stop_threshold_seconds) AS micro_stops,
            COALESCE(sum(dp.duration_seconds) FILTER (WHERE dp.duration_seconds < m.micro_stop_threshold_seconds), 0) AS micro_stop_seconds,
            count(dp.id) FILTER (WHERE dp.duration_seconds >= m.micro_stop_threshold_seconds AND dp.fault_report_id IS NULL) AS unexplained
     FROM machines m
     LEFT JOIN downtime_periods dp ON dp.machine_id = m.id AND dp.ended_at > now() - make_interval(hours => $1)
     WHERE m.is_active
     GROUP BY m.id, m.name, m.micro_stop_threshold_seconds
     ORDER BY m.name`,
    [hours],
  );
  return result.rows.map((r) => ({
    machineId: r.machine_id,
    machineName: r.machine_name,
    microStopThresholdSeconds: r.threshold,
    stops: Number(r.stops),
    stopSeconds: Number(r.stop_seconds),
    microStops: Number(r.micro_stops),
    microStopSeconds: Number(r.micro_stop_seconds),
    unexplained: Number(r.unexplained),
  }));
}

export type ParetoKind = "code" | "unexplained" | "micro";

export interface ParetoItem {
  kind: ParetoKind;
  /** Csak kind = "code" esetén. */
  code: string | null;
  name: string | null;
  periods: number;
  seconds: number;
}

export interface DowntimePareto {
  hours: number;
  machineId: string | null;
  totalSeconds: number;
  /** A küszöb feletti leállási időből ennyi másodpercnek van (el nem utasított) oka. */
  explainedSeconds: number;
  /** A küszöb feletti leállási idő (a lefedettség nevezője). */
  explainableSeconds: number;
  /** Csökkenő idő szerint. */
  items: ParetoItem[];
}

/**
 * Leállási idő okonként (Pareto), az utolsó `hours` órában lezárult
 * periódusokra, opcionálisan egy gépre szűrve.
 *
 * Besorolás, ebben a sorrendben:
 *  1. van oka (el nem utasított hibajelentés) → a hibakód sávja — akkor is,
 *     ha a leállás rövidebb a küszöbnél (a kifejezett magyarázat nyer);
 *  2. rövidebb a gép küszöbénél → "micro" (mikroleállások összesen);
 *  3. különben → "unexplained" (ide tartozik az elutasított magyarázat is,
 *     mert a valódi ok ismeretlen).
 * A hibakódok gépenként definiáltak; az összes gépre vetített nézetben a
 * kód + név szerint vonódnak össze.
 */
export async function getDowntimePareto(hours: number, machineId: string | null): Promise<DowntimePareto> {
  const result = await pool.query<{ kind: ParetoKind; code: string | null; name: string | null; periods: string; seconds: string }>(
    `WITH p AS (
       SELECT dp.duration_seconds,
              CASE
                WHEN fc.id IS NOT NULL AND fr.status <> 'rejected' THEN 'code'
                WHEN dp.duration_seconds < m.micro_stop_threshold_seconds THEN 'micro'
                ELSE 'unexplained'
              END AS kind,
              fc.code, fc.name
       FROM downtime_periods dp
       JOIN machines m ON m.id = dp.machine_id AND m.is_active
       LEFT JOIN fault_reports fr ON fr.id = dp.fault_report_id
       LEFT JOIN machine_fault_codes fc ON fc.id = fr.fault_code_id
       WHERE dp.ended_at > now() - make_interval(hours => $1)
         AND ($2::text IS NULL OR dp.machine_id = $2)
     )
     SELECT kind,
            CASE WHEN kind = 'code' THEN code END AS code,
            CASE WHEN kind = 'code' THEN name END AS name,
            count(*) AS periods,
            sum(duration_seconds) AS seconds
     FROM p
     GROUP BY 1, 2, 3
     ORDER BY sum(duration_seconds) DESC, 1, 2, 3`,
    [hours, machineId],
  );
  const items = result.rows.map((r) => ({
    kind: r.kind,
    code: r.code,
    name: r.name,
    periods: Number(r.periods),
    seconds: Number(r.seconds),
  }));
  const sumOf = (kinds: ParetoKind[]) => items.filter((i) => kinds.includes(i.kind)).reduce((a, i) => a + i.seconds, 0);
  return {
    hours,
    machineId,
    totalSeconds: sumOf(["code", "unexplained", "micro"]),
    explainedSeconds: sumOf(["code"]),
    explainableSeconds: sumOf(["code", "unexplained"]),
    items,
  };
}

/** A gép mikroleállási küszöbe. `undefined`, ha a gép nem létezik. */
export async function setMicroStopThreshold(machineId: string, seconds: number): Promise<{ previous: number } | undefined> {
  const result = await pool.query<{ previous: number }>(
    `UPDATE machines m SET micro_stop_threshold_seconds = $2
     FROM (SELECT id, micro_stop_threshold_seconds AS previous FROM machines WHERE id = $1) old
     WHERE m.id = old.id
     RETURNING old.previous`,
    [machineId, seconds],
  );
  return result.rows[0];
}

export interface ExplainDowntimeInput {
  faultCodeId: string;
  comment?: string;
  reportedBy: string;
}

/**
 * Egy leállás megmagyarázása hibajelentéssel. Versenyhelyzet-biztos: a
 * hozzárendelés csak akkor sikerül, ha a periódus még magyarázatlan. Ha két
 * kérés (pl. dupla kattintás) közel egyszerre érkezik, a vesztes kérés által
 * már létrehozott hibajelentés törlődik — korábban mindkettő megmaradt, és
 * egy leállásra két jelentés jutott, ami torzította a hibastatisztikát.
 */
export async function explainDowntimePeriod(periodId: string, input: ExplainDowntimeInput) {
  const periodResult = await pool.query<{ machine_id: string }>(
    `SELECT machine_id FROM downtime_periods WHERE id = $1 AND fault_report_id IS NULL`,
    [periodId],
  );
  const period = periodResult.rows[0];
  if (!period) return undefined;

  const report = await createFaultReport({
    machineId: period.machine_id,
    faultCodeId: input.faultCodeId,
    occurrenceCount: 1,
    comment: input.comment,
    reportedBy: input.reportedBy,
  });

  const linked = await pool.query(
    `UPDATE downtime_periods SET fault_report_id = $2 WHERE id = $1 AND fault_report_id IS NULL`,
    [periodId, report.id],
  );
  if ((linked.rowCount ?? 0) === 0) {
    // Közben valaki más magyarázta meg — a saját, már felesleges jelentést visszavonjuk.
    await pool.query(`DELETE FROM fault_reports WHERE id = $1`, [report.id]);
    return undefined;
  }
  return report;
}
