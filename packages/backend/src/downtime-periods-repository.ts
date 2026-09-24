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

export async function listUnexplainedDowntimePeriods(machineId?: string): Promise<DowntimePeriod[]> {
  const params: unknown[] = [];
  let where = "dp.fault_report_id IS NULL";
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

export interface ExplainDowntimeInput {
  faultCodeId: string;
  comment?: string;
  reportedBy: string;
}

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

  await pool.query(`UPDATE downtime_periods SET fault_report_id = $2 WHERE id = $1`, [periodId, report.id]);

  return report;
}