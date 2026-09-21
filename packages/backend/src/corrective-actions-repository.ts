import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

export interface CorrectiveAction {
  id: string;
  faultReportId: string;
  description: string;
  performedByEmail: string | null;
  performedAt: string;
  signedOffByEmail: string | null;
  signedOffAt: string | null;
}

type CorrectiveActionRow = {
  id: string;
  fault_report_id: string;
  description: string;
  performed_by_email: string | null;
  performed_at: string;
  signed_off_by_email: string | null;
  signed_off_at: string | null;
};

function toCorrectiveAction(row: CorrectiveActionRow): CorrectiveAction {
  return {
    id: row.id,
    faultReportId: row.fault_report_id,
    description: row.description,
    performedByEmail: row.performed_by_email,
    performedAt: row.performed_at,
    signedOffByEmail: row.signed_off_by_email,
    signedOffAt: row.signed_off_at,
  };
}

const SELECT_JOINED = `
  SELECT
    ca.*,
    performer.email AS performed_by_email,
    signer.email AS signed_off_by_email
  FROM corrective_actions ca
  LEFT JOIN users performer ON performer.id = ca.performed_by
  LEFT JOIN users signer ON signer.id = ca.signed_off_by
`;

export async function listCorrectiveActions(): Promise<CorrectiveAction[]> {
  const result = await pool.query<CorrectiveActionRow>(`${SELECT_JOINED} ORDER BY ca.performed_at DESC`);
  return result.rows.map(toCorrectiveAction);
}

export interface CreateCorrectiveActionInput {
  faultReportId: string;
  description: string;
  performedBy: string;
}

export async function createCorrectiveAction(input: CreateCorrectiveActionInput): Promise<CorrectiveAction> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO corrective_actions (id, fault_report_id, description, performed_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [randomUUID(), input.faultReportId, input.description, input.performedBy],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error("INSERT ... RETURNING unexpectedly returned no row");
  const result = await pool.query<CorrectiveActionRow>(`${SELECT_JOINED} WHERE ca.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw new Error("failed to load newly created corrective action");
  return toCorrectiveAction(row);
}

export async function signOffCorrectiveAction(
  id: string,
  signedOffBy: string,
): Promise<CorrectiveAction | undefined> {
  await pool.query(
    `UPDATE corrective_actions SET signed_off_by = $2, signed_off_at = now() WHERE id = $1 AND signed_off_at IS NULL`,
    [id, signedOffBy],
  );
  const result = await pool.query<CorrectiveActionRow>(`${SELECT_JOINED} WHERE ca.id = $1`, [id]);
  return result.rows[0] ? toCorrectiveAction(result.rows[0]) : undefined;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23503";
}