import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

export type FaultReportStatus = "pending" | "confirmed" | "modified" | "rejected";

export interface FaultReport {
  id: string;
  machineId: string;
  machineName: string;
  faultCodeId: string;
  faultCode: string;
  faultName: string;
  occurrenceCount: number;
  comment: string | null;
  status: FaultReportStatus;
  reportedByEmail: string | null;
  reportedAt: string;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  reviewerNote: string | null;
}

type FaultReportRow = {
  id: string;
  machine_id: string;
  machine_name: string;
  fault_code_id: string;
  fault_code: string;
  fault_name: string;
  occurrence_count: number;
  comment: string | null;
  status: FaultReportStatus;
  reported_by_email: string | null;
  reported_at: string;
  reviewed_by_email: string | null;
  reviewed_at: string | null;
  reviewer_note: string | null;
};

function toFaultReport(row: FaultReportRow): FaultReport {
  return {
    id: row.id,
    machineId: row.machine_id,
    machineName: row.machine_name,
    faultCodeId: row.fault_code_id,
    faultCode: row.fault_code,
    faultName: row.fault_name,
    occurrenceCount: row.occurrence_count,
    comment: row.comment,
    status: row.status,
    reportedByEmail: row.reported_by_email,
    reportedAt: row.reported_at,
    reviewedByEmail: row.reviewed_by_email,
    reviewedAt: row.reviewed_at,
    reviewerNote: row.reviewer_note,
  };
}

const SELECT_JOINED = `
  SELECT
    fr.*,
    m.name AS machine_name,
    fc.code AS fault_code,
    fc.name AS fault_name,
    reporter.email AS reported_by_email,
    reviewer.email AS reviewed_by_email
  FROM fault_reports fr
  JOIN machines m ON m.id = fr.machine_id
  JOIN machine_fault_codes fc ON fc.id = fr.fault_code_id
  LEFT JOIN users reporter ON reporter.id = fr.reported_by
  LEFT JOIN users reviewer ON reviewer.id = fr.reviewed_by
`;

export async function listFaultReports(): Promise<FaultReport[]> {
  const result = await pool.query<FaultReportRow>(
    `${SELECT_JOINED} ORDER BY fr.status = 'pending' DESC, fr.reported_at DESC`,
  );
  return result.rows.map(toFaultReport);
}

export interface CreateFaultReportInput {
  machineId: string;
  faultCodeId: string;
  occurrenceCount?: number;
  comment?: string;
  reportedBy: string;
}

export async function createFaultReport(input: CreateFaultReportInput): Promise<FaultReport> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO fault_reports (id, machine_id, fault_code_id, occurrence_count, comment, reported_by)
     VALUES ($1, $2, $3, COALESCE($4, 1), $5, $6)
     RETURNING id`,
    [
      randomUUID(),
      input.machineId,
      input.faultCodeId,
      input.occurrenceCount ?? null,
      input.comment ?? null,
      input.reportedBy,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error("INSERT ... RETURNING unexpectedly returned no row");
  const result = await pool.query<FaultReportRow>(`${SELECT_JOINED} WHERE fr.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw new Error("failed to load newly created fault report");
  return toFaultReport(row);
}

export interface ReviewFaultReportInput {
  status: "confirmed" | "modified" | "rejected";
  adjustedCount?: number;
  reviewerNote?: string;
}

export async function reviewFaultReport(
  id: string,
  reviewerId: string,
  input: ReviewFaultReportInput,
): Promise<FaultReport | undefined> {
  await pool.query(
    `UPDATE fault_reports SET
       status = $2,
       occurrence_count = COALESCE($3, occurrence_count),
       reviewer_note = COALESCE($4, reviewer_note),
       reviewed_by = $5,
       reviewed_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [id, input.status, input.adjustedCount ?? null, input.reviewerNote ?? null, reviewerId],
  );
  const result = await pool.query<FaultReportRow>(`${SELECT_JOINED} WHERE fr.id = $1`, [id]);
  return result.rows[0] ? toFaultReport(result.rows[0]) : undefined;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23503";
}