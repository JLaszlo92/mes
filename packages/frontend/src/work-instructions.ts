/**
 * Munkautasítások — közös típusok és hívások a dashboard (táblázat,
 * szerkesztő, rendelés-szerkesztő) és a terminál számára.
 */
import { apiFetch, API_BASE } from "./api.js";
import { readJsonOrThrow } from "./master-data.js";

export interface WorkInstruction {
  id: string;
  partName: string;
  version: number;
  content: string;
  /** Link to a document stored elsewhere (older instructions). */
  pdfUrl: string | null;
  /** Uploaded PDF, stored by the server. */
  pdfFileId: string | null;
  pdfFileName: string | null;
  pdfSizeBytes: number | null;
  isCurrent: boolean;
  createdByEmail: string | null;
  createdAt: string;
  openWorkOrders?: number;
}

export interface InstructionView {
  id: string;
  partName: string;
  version: number;
  orderNumber: string | null;
  viewedByEmail: string | null;
  viewedAt: string;
}

/** Same limit as the backend (work-instruction-input.ts). */
export const MAX_PDF_BYTES = 15 * 1024 * 1024;

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function listInstructions(): Promise<WorkInstruction[]> {
  return apiFetch(`${API_BASE}/api/work-instructions`).then((r) => readJsonOrThrow<WorkInstruction[]>(r));
}

/** Why a chosen file cannot be uploaded, or null. Checked before any request. */
export function pdfFileProblem(file: File): string | null {
  if (file.size === 0) return "The file is empty.";
  if (file.size > MAX_PDF_BYTES) return `The file is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_PDF_BYTES)}.`;
  if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) return "Choose a PDF file.";
  return null;
}

/** Uploads the PDF as the request body; the name travels in a header. */
export async function uploadInstructionPdf(file: File): Promise<{ id: string; sizeBytes: number; fileName: string }> {
  const res = await apiFetch(`${API_BASE}/api/work-instructions/files`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent(file.name) },
    body: file,
  });
  if (res.status === 413) throw new Error(`The file is too large (limit ${formatBytes(MAX_PDF_BYTES)}).`);
  return readJsonOrThrow(res);
}

/** The instruction a work order shows at the terminal: the chosen one, else the one named like the part. */
export function instructionForOrder(
  instructions: WorkInstruction[],
  order: { partName: string; workInstructionName: string | null },
): WorkInstruction | undefined {
  const name = order.workInstructionName ?? order.partName.trim();
  return instructions.find((i) => i.partName === name);
}
