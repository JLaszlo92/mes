/**
 * Work instruction inputs: pure validation (__tests__/work-instruction-input.test.ts).
 * Errors are { field, error }, like the other *-input.ts modules.
 */
import type { ValidationResult } from "./machine-input.js";

/** Upload limit. nginx allows 25 MB per request (ops/proxy/mes-nginx.conf). */
export const MAX_PDF_BYTES = 15 * 1024 * 1024;
export const MAX_CONTENT_CHARS = 20_000;

export interface WorkInstructionCreate {
  partName: string;
  content: string;
  pdfUrl: string | null;
  pdfFileId: string | null;
  pdfFileName: string | null;
}

class FieldError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const RESERVED_NAMES = new Set(["files", "view", "views"]);
const FIELDS = ["partName", "content", "pdfUrl", "pdfFileId", "pdfFileName"];

/**
 * A display name for an uploaded file: no directories, no control characters,
 * at most 150 characters, always ending in ".pdf". Never used as a path.
 */
export function sanitizePdfFileName(raw: unknown): string {
  let name = typeof raw === "string" ? raw : "";
  name = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").trim();
  name = name.replace(/\.pdf$/i, "").replace(/^\.+/, "").trim();
  if (name.length > 146) name = name.slice(0, 146).trim();
  return `${name === "" ? "document" : name}.pdf`;
}

/** A PDF starts with "%PDF-" (readers accept it within the first 1024 bytes). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  return head.includes("%PDF-");
}

export function checkPdfUpload(bytes: unknown): ValidationResult<Buffer> {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { ok: false, field: "file", error: "the upload is empty" };
  if (bytes.length > MAX_PDF_BYTES) {
    return { ok: false, field: "file", error: `the file is larger than ${MAX_PDF_BYTES / 1024 / 1024} MB` };
  }
  if (!looksLikePdf(bytes)) return { ok: false, field: "file", error: "the file is not a PDF" };
  return { ok: true, value: bytes };
}

function optionalHttpUrl(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new FieldError("pdfUrl", "pdfUrl must be a link or null");
  const t = v.trim();
  if (t === "") return null;
  if (t.length > 2000) throw new FieldError("pdfUrl", "pdfUrl must be at most 2000 characters");
  let protocol: string;
  try {
    protocol = new URL(t).protocol;
  } catch {
    throw new FieldError("pdfUrl", "pdfUrl must be a full link starting with http:// or https://");
  }
  // javascript:, data: and the like must never end up in an <a href> on the terminal.
  if (protocol !== "http:" && protocol !== "https:") throw new FieldError("pdfUrl", "pdfUrl must start with http:// or https://");
  return t;
}

export function parseWorkInstructionCreate(body: unknown): ValidationResult<WorkInstructionCreate> {
  try {
    if (!isRecord(body)) throw new FieldError("body", "request body must be a JSON object");
    for (const key of Object.keys(body)) {
      if (!FIELDS.includes(key)) throw new FieldError(key, `unknown field "${key}"`);
    }
    if (typeof body.partName !== "string" || body.partName.trim() === "") throw new FieldError("partName", "partName must be a non-empty string");
    const partName = body.partName.trim();
    if (partName.length > 200) throw new FieldError("partName", "partName must be at most 200 characters");
    // These would be shadowed by the fixed routes /files/:id, /view and /views/log.
    if (RESERVED_NAMES.has(partName.toLowerCase())) throw new FieldError("partName", `"${partName}" cannot be used as a name`);

    const rawContent = body.content ?? "";
    if (typeof rawContent !== "string") throw new FieldError("content", "content must be a string");
    const content = rawContent.trim();
    if (content.length > MAX_CONTENT_CHARS) throw new FieldError("content", `content must be at most ${MAX_CONTENT_CHARS} characters`);

    const pdfUrl = optionalHttpUrl(body.pdfUrl);

    let pdfFileId: string | null = null;
    if (body.pdfFileId !== undefined && body.pdfFileId !== null && body.pdfFileId !== "") {
      if (typeof body.pdfFileId !== "string" || body.pdfFileId.length > 100) throw new FieldError("pdfFileId", "pdfFileId must be the id of an uploaded file");
      pdfFileId = body.pdfFileId;
    }
    const pdfFileName = pdfFileId ? sanitizePdfFileName(body.pdfFileName) : null;

    if (content === "" && !pdfFileId && !pdfUrl) {
      throw new FieldError("content", "enter the instructions, upload a PDF, or give a link");
    }
    return { ok: true, value: { partName, content, pdfUrl, pdfFileId, pdfFileName } };
  } catch (err) {
    if (err instanceof FieldError) return { ok: false, field: err.field, error: err.message };
    throw err;
  }
}
