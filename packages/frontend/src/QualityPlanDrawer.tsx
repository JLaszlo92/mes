import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import Drawer from "./ui/Drawer.js";
import Field from "./ui/Field.js";
import { formatDateTime } from "./ui/format.js";
import { PDF_LABELS_EN } from "./ui/pdf-labels.js";
import { ApiError } from "./master-data.js";
import { archivePlan, fmt, formatLimits, listPlanVersions, savePlan, uploadPlanPdf, type CharacteristicKind, type QualityPlan } from "./quality.js";
import { formatBytes, pdfFileProblem } from "./work-instructions.js";

const PdfViewer = lazy(() => import("./ui/PdfViewer.js"));

export type PlanTarget = { mode: "create" } | { mode: "edit"; plan: QualityPlan };

type Pdf = { kind: "none" } | { kind: "stored"; fileId: string; fileName: string } | { kind: "new"; file: File };

interface CharDraft {
  key: number;
  name: string;
  kind: CharacteristicKind;
  nominal: string;
  lowerLimit: string;
  upperLimit: string;
  unit: string;
  method: string;
  pdf: Pdf;
  inFirstPiece: boolean;
  inLastPiece: boolean;
  inSpot: boolean;
}

interface Draft {
  partName: string;
  notes: string;
  firstEnabled: boolean;
  firstGates: boolean;
  lastEnabled: boolean;
  lastGates: boolean;
  spotEnabled: boolean;
  spotEveryParts: string;
  spotMaxMinutes: string;
  spotGraceMinutes: string;
  chars: CharDraft[];
}

let nextKey = 1;
const str = (n: number | null | undefined) => (n === null || n === undefined ? "" : fmt(n));

function emptyChar(): CharDraft {
  return { key: nextKey++, name: "", kind: "variable", nominal: "", lowerLimit: "", upperLimit: "", unit: "mm", method: "", pdf: { kind: "none" }, inFirstPiece: true, inLastPiece: true, inSpot: true };
}

function toDraft(plan?: QualityPlan): Draft {
  if (!plan) {
    return {
      partName: "",
      notes: "",
      firstEnabled: true,
      firstGates: true,
      lastEnabled: false,
      lastGates: true,
      spotEnabled: false,
      spotEveryParts: "",
      spotMaxMinutes: "60",
      spotGraceMinutes: "15",
      chars: [emptyChar()],
    };
  }
  return {
    partName: plan.partName,
    notes: plan.notes ?? "",
    firstEnabled: plan.firstPiece.enabled,
    firstGates: plan.firstPiece.gatesCounting,
    lastEnabled: plan.lastPiece.enabled,
    lastGates: plan.lastPiece.gatesCompletion,
    spotEnabled: plan.spot.enabled,
    spotEveryParts: str(plan.spot.everyParts),
    spotMaxMinutes: str(plan.spot.maxMinutes),
    spotGraceMinutes: String(plan.spot.graceMinutes),
    chars: plan.characteristics.map((c) => ({
      key: nextKey++,
      name: c.name,
      kind: c.kind,
      nominal: str(c.nominal),
      lowerLimit: str(c.lowerLimit),
      upperLimit: str(c.upperLimit),
      unit: c.unit ?? "",
      method: c.method ?? "",
      pdf: c.pdfFileId ? { kind: "stored", fileId: c.pdfFileId, fileName: c.pdfFileName ?? "document.pdf" } : { kind: "none" },
      inFirstPiece: c.inFirstPiece,
      inLastPiece: c.inLastPiece,
      inSpot: c.inSpot,
    })),
  };
}

function comparable(d: Draft) {
  return JSON.stringify({ ...d, chars: d.chars.map(({ key: _k, pdf, ...rest }) => ({ ...rest, pdf: pdf.kind === "new" ? pdf.file.name : pdf.kind === "stored" ? pdf.fileId : null })) });
}

/** Local checks, so the obvious mistakes show at once; the server checks everything again. */
function localErrors(d: Draft, creating: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (creating && !d.partName.trim()) e.partName = "The part name is required.";
  const isNum = (s: string) => s.trim() === "" || Number.isFinite(Number(s.replace(",", ".")));
  d.chars.forEach((c, i) => {
    if (!c.name.trim()) e[`c${i}.name`] = "Name it.";
    if (c.kind === "variable") {
      for (const k of ["nominal", "lowerLimit", "upperLimit"] as const) if (!isNum(c[k])) e[`c${i}.${k}`] = "Not a number.";
      if (!c.lowerLimit.trim() && !c.upperLimit.trim()) e[`c${i}.lowerLimit`] = "Give a lower or an upper limit.";
      const lo = Number(c.lowerLimit.replace(",", "."));
      const hi = Number(c.upperLimit.replace(",", "."));
      if (c.lowerLimit.trim() && c.upperLimit.trim() && lo > hi) e[`c${i}.upperLimit`] = "Below the lower limit.";
    }
    if (!c.inFirstPiece && !c.inLastPiece && !c.inSpot) e[`c${i}.in`] = "Choose at least one check.";
  });
  if (d.spotEnabled && !d.spotEveryParts.trim() && !d.spotMaxMinutes.trim()) e.spot = "Give the number of parts, the longest time, or both.";
  if (d.firstEnabled && !d.chars.some((c) => c.inFirstPiece)) e.first = "No measurement is marked for the first piece.";
  if (d.lastEnabled && !d.chars.some((c) => c.inLastPiece)) e.last = "No measurement is marked for the last piece.";
  if (d.spotEnabled && !d.chars.some((c) => c.inSpot)) e.spotChars = "No measurement is marked for the spot check.";
  return e;
}

const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s.replace(",", ".")));

/**
 * Minőségellenőrzési terv egy part-hoz: melyik ellenőrzés kell (első darab,
 * utolsó darab, szúrópróba), mi blokkol, és a mérési jellemzők sorrendben.
 * A mentés mindig új verzió; a korábbi mérések a saját verziójukra mutatnak.
 */
export default function QualityPlanDrawer({
  target,
  canEdit,
  partNames,
  onClose,
  onSaved,
}: {
  target: PlanTarget;
  canEdit: boolean;
  partNames: string[];
  onClose: () => void;
  onSaved: (plan: QualityPlan | null, message: string) => void;
}) {
  const creating = target.mode === "create";
  const current = target.mode === "edit" ? target.plan : undefined;
  const [initial] = useState(() => toDraft(current));
  const [draft, setDraft] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState<null | "upload" | "save" | "archive">(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [versions, setVersions] = useState<QualityPlan[] | null>(null);
  const [viewPdf, setViewPdf] = useState<{ fileId: string; name: string } | null>(null);
  const fileFor = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!current) return;
    let alive = true;
    listPlanVersions(current.partName)
      .then((v) => alive && setVersions(v))
      .catch(() => alive && setVersions([]));
    return () => {
      alive = false;
    };
  }, [current]);

  const changed = comparable(draft) !== comparable(initial) || (current !== undefined && !current.isActive);
  const errors = localErrors(draft, creating);
  const err = (k: string) => (touched ? errors[k] : undefined);
  const busy = saving !== null;

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setServerError(null);
  }
  function setChar(i: number, patch: Partial<CharDraft>) {
    setDraft((d) => ({ ...d, chars: d.chars.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
    setServerError(null);
  }
  function move(i: number, by: -1 | 1) {
    setDraft((d) => {
      const chars = [...d.chars];
      const j = i + by;
      if (j < 0 || j >= chars.length) return d;
      [chars[i], chars[j]] = [chars[j]!, chars[i]!];
      return { ...d, chars };
    });
  }

  function requestClose() {
    if (busy) return;
    if (viewPdf) return setViewPdf(null);
    if (canEdit && changed && !window.confirm(creating ? "Discard this new plan?" : "Discard unsaved changes?")) return;
    onClose();
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0 || !canEdit || busy) return;
    setServerError(null);
    try {
      // Upload the new PDFs first; a retry after a later failure does not upload them again.
      const chars = [...draft.chars];
      for (const [i, c] of chars.entries()) {
        if (c.pdf.kind !== "new") continue;
        setSaving("upload");
        const up = await uploadPlanPdf(c.pdf.file);
        chars[i] = { ...c, pdf: { kind: "stored", fileId: up.id, fileName: up.fileName } };
        setDraft((d) => ({ ...d, chars: d.chars.map((x) => (x.key === c.key ? chars[i]! : x)) }));
      }
      setSaving("save");
      const plan = await savePlan({
        partName: draft.partName.trim(),
        notes: draft.notes.trim() || null,
        firstPiece: { enabled: draft.firstEnabled, gatesCounting: draft.firstGates },
        lastPiece: { enabled: draft.lastEnabled, gatesCompletion: draft.lastGates },
        spot: { enabled: draft.spotEnabled, everyParts: numOrNull(draft.spotEveryParts), maxMinutes: numOrNull(draft.spotMaxMinutes), graceMinutes: numOrNull(draft.spotGraceMinutes) ?? 15 },
        characteristics: chars.map((c) => ({
          name: c.name.trim(),
          kind: c.kind,
          nominal: c.kind === "variable" ? numOrNull(c.nominal) : null,
          lowerLimit: c.kind === "variable" ? numOrNull(c.lowerLimit) : null,
          upperLimit: c.kind === "variable" ? numOrNull(c.upperLimit) : null,
          unit: c.kind === "variable" ? c.unit.trim() || null : null,
          method: c.method.trim() || null,
          pdfFileId: c.pdf.kind === "stored" ? c.pdf.fileId : null,
          pdfFileName: c.pdf.kind === "stored" ? c.pdf.fileName : null,
          inFirstPiece: c.inFirstPiece,
          inLastPiece: c.inLastPiece,
          inSpot: c.inSpot,
        })),
      });
      onSaved(plan, plan.version === 1 ? `Quality plan for ${plan.partName} created.` : `${plan.partName} saved as version ${plan.version}.`);
    } catch (error) {
      setServerError(error instanceof ApiError || error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(null);
    }
  }

  async function archive() {
    if (!current || !window.confirm(`Turn off the quality plan of ${current.partName}? New orders of this part will not be checked. The recorded checks stay.`)) return;
    setSaving("archive");
    try {
      await archivePlan(current.partName);
      onSaved(null, `The quality plan of ${current.partName} is turned off.`);
    } catch (error) {
      setServerError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(null);
    }
  }

  const formId = "quality-plan-form";
  const nextVersion = (versions?.[0]?.version ?? current?.version ?? 0) + 1;
  const showErrors = touched && Object.keys(errors).length > 0;

  return (
    <Drawer
      title={creating ? "New quality plan" : current!.partName}
      subtitle={
        creating
          ? "Work orders of a part with exactly this name use it automatically."
          : `Version ${current!.version}${current!.isActive ? "" : " · turned off"} · ${current!.openWorkOrders ?? 0} open work order${current!.openWorkOrders === 1 ? "" : "s"}`
      }
      onRequestClose={requestClose}
      footer={
        canEdit ? (
          <>
            {current?.isActive && (
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-danger" onClick={archive} disabled={busy}>
                Turn off
              </button>
            )}
            <span className="ui-field-hint" style={{ flex: 1 }}>
              {saving === "upload" ? "Uploading PDFs…" : !creating && changed ? "Unsaved changes" : ""}
            </span>
            <button type="button" className="ui-btn" onClick={requestClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy || (!creating && !changed)}>
              {busy ? "Saving…" : creating ? "Create plan" : `Save as version ${nextVersion}`}
            </button>
          </>
        ) : (
          <>
            <span className="ui-field-hint" style={{ flex: 1 }}>
              Only a quality supervisor can change quality plans.
            </span>
            <button type="button" className="ui-btn" onClick={onClose}>
              Close
            </button>
          </>
        )
      }
    >
      <input
        ref={fileInput}
        className="ui-file-input"
        type="file"
        accept="application/pdf,.pdf"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          const i = fileFor.current;
          if (!file || i === null) return;
          const problem = pdfFileProblem(file);
          setFileError(problem);
          if (!problem) setChar(i, { pdf: { kind: "new", file } });
        }}
      />
      <form id={formId} onSubmit={save} noValidate>
        <fieldset disabled={!canEdit || busy} style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
          {serverError && <p className="ui-message ui-message-error">{serverError}</p>}
          {showErrors && <p className="ui-message ui-message-error">Some fields need attention (marked below).</p>}
          {fileError && <p className="ui-message ui-message-error">{fileError}</p>}

          {creating && (
            <section className="ui-section">
              <Field label="Part" error={err("partName")} hint="The part name as on the work orders. Cannot be changed later.">
                <input className="ui-input" list="quality-part-names" value={draft.partName} onChange={(e) => set("partName", e.target.value)} placeholder="Bracket A-12" />
              </Field>
              <datalist id="quality-part-names">
                {partNames.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </section>
          )}

          <section className="ui-section">
            <h3 className="ui-section-title">Checks</h3>
            <div className="q-check-block">
              <label className="ui-check">
                <input type="checkbox" checked={draft.firstEnabled} onChange={(e) => set("firstEnabled", e.target.checked)} />
                <strong>First piece</strong> — when the order is started
              </label>
              {draft.firstEnabled && (
                <label className="ui-check q-sub-option">
                  <input type="checkbox" checked={draft.firstGates} onChange={(e) => set("firstGates", e.target.checked)} />
                  Parts are counted only after it passes
                </label>
              )}
              {err("first") && <p className="ui-field-error">{err("first")}</p>}
            </div>
            <div className="q-check-block">
              <label className="ui-check">
                <input type="checkbox" checked={draft.lastEnabled} onChange={(e) => set("lastEnabled", e.target.checked)} />
                <strong>Last piece</strong> — when the order is completed
              </label>
              {draft.lastEnabled && (
                <label className="ui-check q-sub-option">
                  <input type="checkbox" checked={draft.lastGates} onChange={(e) => set("lastGates", e.target.checked)} />
                  The order can be completed only after it passes (otherwise it can be skipped)
                </label>
              )}
              {err("last") && <p className="ui-field-error">{err("last")}</p>}
            </div>
            <div className="q-check-block">
              <label className="ui-check">
                <input type="checkbox" checked={draft.spotEnabled} onChange={(e) => set("spotEnabled", e.target.checked)} />
                <strong>Spot check</strong> — during production
              </label>
              {draft.spotEnabled && (
                <div className="q-spot-grid">
                  <Field label="Every … parts" hint="Empty: only by time.">
                    <input className="ui-input" inputMode="numeric" value={draft.spotEveryParts} onChange={(e) => set("spotEveryParts", e.target.value)} placeholder="50" />
                  </Field>
                  <Field label="At the latest every … min" hint="Raised in any case when the time is up.">
                    <input className="ui-input" inputMode="numeric" value={draft.spotMaxMinutes} onChange={(e) => set("spotMaxMinutes", e.target.value)} placeholder="60" />
                  </Field>
                  <Field label="Alert if not done in … min">
                    <input className="ui-input" inputMode="numeric" value={draft.spotGraceMinutes} onChange={(e) => set("spotGraceMinutes", e.target.value)} placeholder="15" />
                  </Field>
                </div>
              )}
              {(err("spot") || err("spotChars")) && <p className="ui-field-error">{err("spot") ?? err("spotChars")}</p>}
            </div>
            <p className="ui-field-hint" style={{ margin: "4px 0 0" }}>
              A measurement outside its limits stops the part count until it is measured again and passes, or a quality supervisor releases it with a reason.
            </p>
          </section>

          <section className="ui-section">
            <h3 className="ui-section-title">Measurements, in the order they are taken</h3>
            {draft.chars.map((c, i) => (
              <div key={c.key} className="q-char">
                <div className="q-char-head">
                  <span className="q-char-no num">{i + 1}</span>
                  <input className="ui-input" value={c.name} onChange={(e) => setChar(i, { name: e.target.value })} placeholder="Diameter Ø10" aria-label={`Measurement ${i + 1} name`} aria-invalid={!!err(`c${i}.name`)} />
                  <select className="ui-select" value={c.kind} onChange={(e) => setChar(i, { kind: e.target.value as CharacteristicKind })} aria-label={`Measurement ${i + 1} type`}>
                    <option value="variable">Measured value</option>
                    <option value="attribute">OK / not OK</option>
                  </select>
                  {canEdit && (
                    <span className="q-char-tools">
                      <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                        ↑
                      </button>
                      <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={() => move(i, 1)} disabled={i === draft.chars.length - 1} aria-label="Move down">
                        ↓
                      </button>
                      <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={() => set("chars", draft.chars.filter((_, j) => j !== i))} aria-label={`Remove measurement ${i + 1}`}>
                        Remove
                      </button>
                    </span>
                  )}
                </div>
                {err(`c${i}.name`) && <p className="ui-field-error">{err(`c${i}.name`)}</p>}
                {c.kind === "variable" && (
                  <div className="q-limits">
                    <Field label="Lower limit" error={err(`c${i}.lowerLimit`)}>
                      <input className="ui-input" inputMode="decimal" value={c.lowerLimit} onChange={(e) => setChar(i, { lowerLimit: e.target.value })} placeholder="9.95" />
                    </Field>
                    <Field label="Nominal" error={err(`c${i}.nominal`)}>
                      <input className="ui-input" inputMode="decimal" value={c.nominal} onChange={(e) => setChar(i, { nominal: e.target.value })} placeholder="10" />
                    </Field>
                    <Field label="Upper limit" error={err(`c${i}.upperLimit`)}>
                      <input className="ui-input" inputMode="decimal" value={c.upperLimit} onChange={(e) => setChar(i, { upperLimit: e.target.value })} placeholder="10.05" />
                    </Field>
                    <Field label="Unit">
                      <input className="ui-input" value={c.unit} onChange={(e) => setChar(i, { unit: e.target.value })} placeholder="mm" />
                    </Field>
                  </div>
                )}
                <div className="q-char-row">
                  <input className="ui-input" value={c.method} onChange={(e) => setChar(i, { method: e.target.value })} placeholder="Gauge / method (optional), e.g. micrometer 0–25 mm" aria-label={`Measurement ${i + 1} gauge`} />
                </div>
                <div className="q-char-row q-char-foot">
                  <span className="q-in">
                    In:
                    <label className="ui-check">
                      <input type="checkbox" checked={c.inFirstPiece} onChange={(e) => setChar(i, { inFirstPiece: e.target.checked })} /> first piece
                    </label>
                    <label className="ui-check">
                      <input type="checkbox" checked={c.inLastPiece} onChange={(e) => setChar(i, { inLastPiece: e.target.checked })} /> last piece
                    </label>
                    <label className="ui-check">
                      <input type="checkbox" checked={c.inSpot} onChange={(e) => setChar(i, { inSpot: e.target.checked })} /> spot check
                    </label>
                  </span>
                  <span className="q-pdf">
                    {c.pdf.kind === "none" ? (
                      canEdit && (
                        <button
                          type="button"
                          className="ui-btn ui-btn-small"
                          onClick={() => {
                            fileFor.current = i;
                            fileInput.current?.click();
                          }}
                        >
                          Attach PDF…
                        </button>
                      )
                    ) : (
                      <>
                        <span className="ui-cell-clip" title={c.pdf.kind === "new" ? c.pdf.file.name : c.pdf.fileName}>
                          {c.pdf.kind === "new" ? `${c.pdf.file.name} (${formatBytes(c.pdf.file.size)}, uploaded on save)` : c.pdf.fileName}
                        </span>
                        {c.pdf.kind === "stored" && (
                          <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={() => c.pdf.kind === "stored" && setViewPdf({ fileId: c.pdf.fileId, name: c.pdf.fileName })}>
                            View
                          </button>
                        )}
                        {canEdit && (
                          <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={() => setChar(i, { pdf: { kind: "none" } })}>
                            Remove
                          </button>
                        )}
                      </>
                    )}
                  </span>
                </div>
                {err(`c${i}.in`) && <p className="ui-field-error">{err(`c${i}.in`)}</p>}
              </div>
            ))}
            {canEdit && (
              <button type="button" className="ui-btn" onClick={() => set("chars", [...draft.chars, emptyChar()])}>
                Add measurement
              </button>
            )}
          </section>

          <section className="ui-section">
            <Field label="Notes (optional)">
              <textarea className="ui-textarea" value={draft.notes} onChange={(e) => set("notes", e.target.value)} />
            </Field>
          </section>
        </fieldset>
      </form>

      {current && (
        <section className="ui-section">
          <h3 className="ui-section-title">Versions</h3>
          {versions === null ? (
            <p className="ui-field-hint">Loading…</p>
          ) : (
            <ul className="q-versions">
              {versions.map((v) => (
                <li key={v.id}>
                  <strong>v{v.version}</strong> · {formatDateTime(v.createdAt)} · {v.createdByName ?? "—"}
                  <span className="ui-sub">
                    {[v.firstPiece.enabled && "first piece", v.lastPiece.enabled && "last piece", v.spot.enabled && "spot check"].filter(Boolean).join(", ") || "no checks"} ·{" "}
                    {v.characteristics.map((c) => `${c.name} ${formatLimits(c)}`).join("; ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {viewPdf && (
        <div className="q-pdf-overlay" role="dialog" aria-label={viewPdf.name}>
          <div className="q-pdf-overlay-head">
            <strong>{viewPdf.name}</strong>
            <button type="button" className="ui-btn ui-btn-small" onClick={() => setViewPdf(null)}>
              Close
            </button>
          </div>
          <Suspense fallback={<div className="ui-pdf-state">{PDF_LABELS_EN.loading}</div>}>
            <PdfViewer fileId={viewPdf.fileId} labels={PDF_LABELS_EN} />
          </Suspense>
        </div>
      )}
    </Drawer>
  );
}
