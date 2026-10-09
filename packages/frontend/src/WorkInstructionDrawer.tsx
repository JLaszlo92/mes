import { useEffect, useRef, useState, type FormEvent } from "react";
import Drawer from "./ui/Drawer.js";
import Field from "./ui/Field.js";
import { apiFetch, API_BASE } from "./api.js";
import { ApiError, readJsonOrThrow } from "./master-data.js";
import { formatDateTime } from "./ui/format.js";
import InstructionViewer, { type ViewerTab } from "./InstructionViewer.js";
import { formatBytes, pdfFileProblem, uploadInstructionPdf, type InstructionView, type WorkInstruction } from "./work-instructions.js";

export type InstructionTarget = { mode: "create" } | { mode: "edit"; instruction: WorkInstruction };

/** The PDF of the draft: none, the one already stored, or a file chosen but not uploaded yet. */
type PdfDraft = { kind: "none" } | { kind: "stored"; fileId: string; fileName: string; sizeBytes: number | null } | { kind: "new"; file: File };

interface Draft {
  partName: string;
  content: string;
  pdfUrl: string;
  pdf: PdfDraft;
}

function toDraft(wi: WorkInstruction | undefined): Draft {
  return {
    partName: wi?.partName ?? "",
    content: wi?.content ?? "",
    pdfUrl: wi?.pdfUrl ?? "",
    pdf: wi?.pdfFileId ? { kind: "stored", fileId: wi.pdfFileId, fileName: wi.pdfFileName ?? "document.pdf", sizeBytes: wi.pdfSizeBytes } : { kind: "none" },
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  if (a.partName !== b.partName || a.content !== b.content || a.pdfUrl !== b.pdfUrl || a.pdf.kind !== b.pdf.kind) return false;
  if (a.pdf.kind === "new") return false;
  return a.pdf.kind !== "stored" || (b.pdf.kind === "stored" && a.pdf.fileId === b.pdf.fileId);
}

function localErrors(d: Draft, creating: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (creating && d.partName.trim() === "") e.partName = "Enter a name.";
  const link = d.pdfUrl.trim();
  if (link !== "" && !/^https?:\/\/\S+$/i.test(link)) e.pdfUrl = "Enter a full link starting with http:// or https://.";
  if (d.content.trim() === "" && d.pdf.kind === "none" && link === "") e.content = "Enter the instructions or add a PDF.";
  return e;
}

/**
 * Munkautasítás szerkesztője. A mentés mindig ÚJ VERZIÓT hoz létre (a régi
 * megmarad a történetben, és a megtekintés-napló arra mutat) — ezért a
 * gomb felirata is ezt mondja. A PDF a mentéskor töltődik fel, nem a
 * kiválasztáskor: egy megszakított szerkesztés nem hagy fájlt a szerveren.
 */
export default function WorkInstructionDrawer({
  target,
  canEdit,
  canSeeLog,
  onClose,
  onSaved,
}: {
  target: InstructionTarget;
  canEdit: boolean;
  canSeeLog: boolean;
  onClose: () => void;
  onSaved: (instruction: WorkInstruction) => void;
}) {
  const creating = target.mode === "create";
  const current = target.mode === "edit" ? target.instruction : undefined;
  const [initial] = useState(() => toDraft(current));
  const [draft, setDraft] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState<null | "upload" | "save">(null);
  const [serverError, setServerError] = useState<{ message: string; field?: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [showLink, setShowLink] = useState(initial.pdfUrl !== "");
  const [versions, setVersions] = useState<WorkInstruction[] | null>(null);
  const [views, setViews] = useState<InstructionView[] | null>(null);
  const [preview, setPreview] = useState<{ instruction: WorkInstruction; tab: ViewerTab } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!current) return;
    let alive = true;
    const name = encodeURIComponent(current.partName);
    apiFetch(`${API_BASE}/api/work-instructions/${name}/versions`)
      .then((r) => readJsonOrThrow<WorkInstruction[]>(r))
      .then((v) => alive && setVersions(v))
      .catch(() => alive && setVersions([]));
    if (canSeeLog) {
      apiFetch(`${API_BASE}/api/work-instructions/views/log?limit=20&partName=${name}`)
        .then((r) => readJsonOrThrow<InstructionView[]>(r))
        .then((v) => alive && setViews(v))
        .catch(() => alive && setViews([]));
    }
    return () => {
      alive = false;
    };
  }, [current, canSeeLog]);

  const changed = !sameDraft(draft, initial);
  const errors = localErrors(draft, creating);
  const fieldError = (f: string) => (touched ? errors[f] : undefined) ?? (serverError?.field === f ? serverError.message : undefined);
  const busy = saving !== null;

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    if (serverError) setServerError(null);
  }

  function chooseFile(file: File | undefined) {
    if (!file) return;
    const problem = pdfFileProblem(file);
    setFileError(problem);
    if (!problem) set("pdf", { kind: "new", file });
  }

  function requestClose() {
    if (busy) return;
    if (preview) return setPreview(null);
    if (canEdit && changed && !window.confirm(creating ? "Discard this new instruction?" : "Discard unsaved changes?")) return;
    onClose();
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0 || !canEdit || busy) return;
    setServerError(null);
    try {
      let pdfFileId: string | null = null;
      let pdfFileName: string | null = null;
      if (draft.pdf.kind === "new") {
        setSaving("upload");
        const uploaded = await uploadInstructionPdf(draft.pdf.file);
        pdfFileId = uploaded.id;
        pdfFileName = uploaded.fileName;
        // If the next step fails, a retry must not upload the file again.
        setDraft((d) => ({ ...d, pdf: { kind: "stored", fileId: uploaded.id, fileName: uploaded.fileName, sizeBytes: uploaded.sizeBytes } }));
      } else if (draft.pdf.kind === "stored") {
        pdfFileId = draft.pdf.fileId;
        pdfFileName = draft.pdf.fileName;
      }
      setSaving("save");
      const res = await apiFetch(`${API_BASE}/api/work-instructions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partName: draft.partName.trim(),
          content: draft.content.trim(),
          pdfUrl: draft.pdfUrl.trim() || null,
          pdfFileId,
          pdfFileName,
        }),
      });
      onSaved(await readJsonOrThrow<WorkInstruction>(res));
    } catch (err) {
      const field = err instanceof ApiError ? err.field : undefined;
      const message = err instanceof Error ? err.message : String(err);
      if (field === "file" || field === "pdfFileId") setFileError(message);
      else setServerError({ message, field });
    } finally {
      setSaving(null);
    }
  }

  const nextVersion = (current?.version ?? 0) + 1;
  const formId = "work-instruction-form";
  const usedBy = current?.openWorkOrders ?? 0;

  return (
    <>
      <Drawer
        title={creating ? "New work instruction" : current!.partName}
        subtitle={
          creating
            ? "Shown at the terminal once the operator starts a work order."
            : `Version ${current!.version} · used by ${usedBy} open work order${usedBy === 1 ? "" : "s"}`
        }
        onRequestClose={requestClose}
        footer={
          canEdit ? (
            <>
              <span className="ui-field-hint" style={{ flex: 1 }}>
                {saving === "upload" ? "Uploading the PDF…" : !creating && changed ? "Unsaved changes" : ""}
              </span>
              <button type="button" className="ui-btn" onClick={requestClose} disabled={busy}>
                Cancel
              </button>
              <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy || (!creating && !changed)}>
                {busy ? "Saving…" : creating ? "Create instruction" : `Save as version ${nextVersion}`}
              </button>
            </>
          ) : (
            <>
              <span className="ui-field-hint" style={{ flex: 1 }}>
                Only admins and managers can change work instructions.
              </span>
              <button type="button" className="ui-btn" onClick={onClose}>
                Close
              </button>
            </>
          )
        }
      >
        <form id={formId} onSubmit={save} noValidate>
          <fieldset disabled={!canEdit || busy} style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
            {serverError && !serverError.field && <p className="ui-message ui-message-error">{serverError.message}</p>}

            <section className="ui-section">
              <h3 className="ui-section-title">Instruction</h3>
              {creating && (
                <div style={{ marginBottom: 12 }}>
                  <Field
                    label="Name"
                    error={fieldError("partName")}
                    hint="Usually the part name: work orders for a part with exactly this name use it automatically. Cannot be changed later."
                  >
                    <input className="ui-input" value={draft.partName} onChange={(e) => set("partName", e.target.value)} placeholder="Bracket A-12" aria-invalid={!!fieldError("partName")} />
                  </Field>
                </div>
              )}
              <Field label="Text" error={fieldError("content")} hint="Shown to the operator as written; line breaks are kept.">
                <textarea className="ui-textarea" style={{ minHeight: 180 }} value={draft.content} onChange={(e) => set("content", e.target.value)} aria-invalid={!!fieldError("content")} />
              </Field>
            </section>

            <section className="ui-section">
              <h3 className="ui-section-title">PDF document</h3>
              <input
                ref={fileInput}
                className="ui-file-input"
                type="file"
                accept="application/pdf,.pdf"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  chooseFile(e.target.files?.[0]);
                  e.target.value = ""; // choosing the same file again must fire a change
                }}
              />
              {draft.pdf.kind === "none" ? (
                <>
                  {canEdit && (
                    <button type="button" className="ui-btn" onClick={() => fileInput.current?.click()}>
                      Upload a PDF…
                    </button>
                  )}
                  <p className="ui-field-hint" style={{ margin: "8px 0 0" }}>
                    {canEdit ? `Optional, up to ${formatBytes(15 * 1024 * 1024)}. It is stored on the server and opens inside the terminal.` : "No PDF attached."}
                  </p>
                </>
              ) : (
                <div className="ui-file">
                  <span className="ui-file-name">
                    {draft.pdf.kind === "new" ? draft.pdf.file.name : draft.pdf.fileName}
                    <span className="ui-sub">
                      {draft.pdf.kind === "new" ? `${formatBytes(draft.pdf.file.size)} · uploaded when you save` : formatBytes(draft.pdf.sizeBytes)}
                    </span>
                  </span>
                  {draft.pdf.kind === "stored" && current && draft.pdf.fileId === current.pdfFileId && (
                    <button
                      type="button"
                      className="ui-btn ui-btn-small"
                      onClick={() => setPreview({ instruction: current, tab: "pdf" })}
                    >
                      View
                    </button>
                  )}
                  {canEdit && (
                    <>
                      <button type="button" className="ui-btn ui-btn-small" onClick={() => fileInput.current?.click()}>
                        Replace…
                      </button>
                      <button
                        type="button"
                        className="ui-btn ui-btn-small ui-btn-ghost"
                        onClick={() => {
                          set("pdf", { kind: "none" });
                          setFileError(null);
                        }}
                      >
                        Remove
                      </button>
                    </>
                  )}
                </div>
              )}
              {fileError && (
                <p className="ui-message ui-message-error" style={{ marginTop: 8 }}>
                  {fileError}
                </p>
              )}

              {showLink ? (
                <div style={{ marginTop: 12 }}>
                  <Field label="Link to a document stored elsewhere" error={fieldError("pdfUrl")} hint="Opens in a new browser tab at the terminal. Prefer an uploaded PDF: a link needs the other server to be reachable from the shop floor.">
                    <input className="ui-input" value={draft.pdfUrl} onChange={(e) => set("pdfUrl", e.target.value)} placeholder="https://…" aria-invalid={!!fieldError("pdfUrl")} />
                  </Field>
                </div>
              ) : (
                canEdit && (
                  <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" style={{ marginTop: 8 }} onClick={() => setShowLink(true)}>
                    Link to a document instead
                  </button>
                )
              )}
            </section>
          </fieldset>
        </form>

        {current && (
          <section className="ui-section">
            <h3 className="ui-section-title">Versions</h3>
            {versions === null ? (
              <p className="ui-field-hint">Loading…</p>
            ) : (
              <ul className="ui-mini-list">
                {versions.map((v) => (
                  <li key={v.id} style={{ alignItems: "center" }}>
                    <span className="num" style={{ minWidth: 34 }}>
                      v{v.version}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      {formatDateTime(v.createdAt)}
                      <span className="ui-sub">{v.createdByEmail ?? "—"}</span>
                    </span>
                    {v.isCurrent && <span className="ui-pill ui-pill-accent">Current</span>}
                    <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={() => setPreview({ instruction: v, tab: "text" })}>
                      View
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="ui-field-hint" style={{ margin: 0 }}>
              Saving never overwrites: every change is a new version, and the terminal always shows the current one.
            </p>
          </section>
        )}

        {current && canSeeLog && (
          <section className="ui-section">
            <h3 className="ui-section-title">Opened at the terminal</h3>
            {views === null ? (
              <p className="ui-field-hint">Loading…</p>
            ) : views.length === 0 ? (
              <p className="ui-field-hint" style={{ margin: 0 }}>
                No operator has opened this instruction yet.
              </p>
            ) : (
              <ul className="ui-mini-list">
                {views.map((v) => (
                  <li key={v.id}>
                    <span className="num" style={{ minWidth: 34 }}>
                      v{v.version}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      {v.viewedByEmail ?? "—"}
                      <span className="ui-sub">{v.orderNumber ? `for ${v.orderNumber}` : "no work order"}</span>
                    </span>
                    <span className="ui-sub">{formatDateTime(v.viewedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </Drawer>
      {preview && (
        <InstructionViewer
          instruction={preview.instruction}
          initialTab={preview.tab}
          subtitle={preview.instruction.isCurrent ? "Preview: what the operator sees" : "Earlier version"}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
