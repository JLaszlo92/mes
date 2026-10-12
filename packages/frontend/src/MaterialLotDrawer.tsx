import { useEffect, useState, type FormEvent } from "react";
import Drawer from "./ui/Drawer.js";
import Field from "./ui/Field.js";
import { apiFetch, API_BASE } from "./api.js";
import { ApiError, readJsonOrThrow } from "./master-data.js";
import { formatDateTime } from "./ui/format.js";
import { openLot, scrapRate, type MaterialLot, type MaterialLotUsage } from "./traceability.js";

export type MaterialLotTarget = { mode: "create" } | { mode: "edit"; lot: MaterialLot };

interface Draft {
  materialName: string;
  lotNumber: string;
  supplier: string;
  receivedAt: string;
}

function toDraft(lot: MaterialLot | undefined): Draft {
  return {
    materialName: lot?.materialName ?? "",
    lotNumber: lot?.lotNumber ?? "",
    supplier: lot?.supplier ?? "",
    receivedAt: lot?.receivedAt ?? "",
  };
}

function toPayload(d: Draft): Record<string, string | null> {
  return {
    materialName: d.materialName.trim(),
    lotNumber: d.lotNumber.trim(),
    supplier: d.supplier.trim() || null,
    receivedAt: d.receivedAt || null,
  };
}

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localErrors(d: Draft): Record<string, string> {
  const e: Record<string, string> = {};
  if (d.materialName.trim() === "") e.materialName = "Enter the material.";
  if (d.lotNumber.trim() === "") e.lotNumber = "Enter the supplier's lot or batch number.";
  if (d.receivedAt && d.receivedAt > today()) e.receivedAt = "A delivery cannot be in the future.";
  return e;
}

const STATUS: Record<string, string> = {
  planned: "Planned",
  released: "Released",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

/**
 * Egy alapanyag-tétel: adatai (új felvétel vagy javítás) és hogy hol
 * használták — a work orderek és a belőlük lett késztermék-tételek. Ez a
 * visszakeresés: hibás beszállítói tételnél innen látszik, mely kész tételek
 * érintettek.
 */
export default function MaterialLotDrawer({
  target,
  canEdit,
  materialNames,
  onClose,
  onSaved,
  onDeleted,
}: {
  target: MaterialLotTarget;
  /** Editing and deleting an existing lot: admin/manager. Anyone signed in may register a new one. */
  canEdit: boolean;
  /** Existing material names, offered while typing so the same material is not spelled two ways. */
  materialNames: string[];
  onClose: () => void;
  onSaved: (lot: MaterialLot, created: boolean) => void;
  onDeleted: (lot: MaterialLot) => void;
}) {
  const creating = target.mode === "create";
  const current = target.mode === "edit" ? target.lot : undefined;
  const editable = creating || canEdit;
  const [initial] = useState(() => toDraft(current));
  const [draft, setDraft] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<{ message: string; field?: string } | null>(null);
  const [usage, setUsage] = useState<MaterialLotUsage[] | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  useEffect(() => {
    if (!current) return;
    let alive = true;
    apiFetch(`${API_BASE}/api/material-lots/${encodeURIComponent(current.id)}/usage`)
      .then((r) => readJsonOrThrow<MaterialLotUsage[]>(r))
      .then((rows) => alive && setUsage(rows))
      .catch((err) => alive && setUsageError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [current]);

  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  const errors = localErrors(draft);
  const fieldError = (f: string) => (touched ? errors[f] : undefined) ?? (serverError?.field === f ? serverError.message : undefined);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    if (serverError) setServerError(null);
  }

  function requestClose() {
    if (busy) return;
    if (editable && changed && !window.confirm(creating ? "Discard this new material lot?" : "Discard unsaved changes?")) return;
    onClose();
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0 || !editable || busy) return;
    setBusy(true);
    setServerError(null);
    try {
      const payload = toPayload(draft);
      let res: Response;
      if (creating) {
        res = await apiFetch(`${API_BASE}/api/material-lots`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else {
        const before = toPayload(initial);
        const diff = Object.fromEntries(Object.entries(payload).filter(([k, v]) => before[k] !== v));
        if (Object.keys(diff).length === 0) return onClose();
        res = await apiFetch(`${API_BASE}/api/material-lots/${encodeURIComponent(current!.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(diff),
        });
      }
      onSaved(await readJsonOrThrow<MaterialLot>(res), creating);
    } catch (err) {
      setServerError(err instanceof ApiError ? { message: err.message, field: err.field } : { message: String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!current || busy) return;
    if (!window.confirm(`Delete material lot ${current.lotNumber}? This cannot be undone.`)) return;
    setBusy(true);
    setServerError(null);
    try {
      await readJsonOrThrow<unknown>(await apiFetch(`${API_BASE}/api/material-lots/${encodeURIComponent(current.id)}`, { method: "DELETE" }));
      onDeleted(current);
    } catch (err) {
      setServerError({ message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  const formId = "material-lot-form";
  const inUse = (usage?.length ?? current?.workOrderCount ?? 0) > 0;

  return (
    <Drawer
      title={creating ? "New material lot" : `${current!.materialName} · ${current!.lotNumber}`}
      subtitle={creating ? "Register a delivery when it arrives, then choose it on the work orders that use it." : current!.supplier ?? undefined}
      onRequestClose={requestClose}
      footer={
        editable ? (
          <>
            {!creating && canEdit && (
              <button
                type="button"
                className="ui-btn ui-btn-danger"
                onClick={() => void remove()}
                disabled={busy || inUse || usage === null}
                title={inUse ? "Used on work orders: remove it there first" : undefined}
              >
                Delete
              </button>
            )}
            <span className="ui-field-hint" style={{ flex: 1 }}>
              {!creating && changed ? "Unsaved changes" : ""}
            </span>
            <button type="button" className="ui-btn" onClick={requestClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy || (!creating && !changed)}>
              {busy ? "Saving…" : creating ? "Add material lot" : "Save changes"}
            </button>
          </>
        ) : (
          <>
            <span className="ui-field-hint" style={{ flex: 1 }}>
              Only admins and managers can change a material lot.
            </span>
            <button type="button" className="ui-btn" onClick={onClose}>
              Close
            </button>
          </>
        )
      }
    >
      <form id={formId} onSubmit={save} noValidate>
        <fieldset disabled={!editable || busy} style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
          {serverError && !serverError.field && <p className="ui-message ui-message-error">{serverError.message}</p>}
          <section className="ui-section">
            <h3 className="ui-section-title">Delivery</h3>
            <div className="ui-grid-2">
              <Field label="Material" error={fieldError("materialName")}>
                <input
                  className="ui-input"
                  list="material-names"
                  value={draft.materialName}
                  onChange={(e) => set("materialName", e.target.value)}
                  placeholder="Acéllemez S235 2 mm"
                  aria-invalid={!!fieldError("materialName")}
                />
              </Field>
              <Field label="Lot number" error={fieldError("lotNumber")} hint="As printed on the delivery note or label.">
                <input className="ui-input" value={draft.lotNumber} onChange={(e) => set("lotNumber", e.target.value)} placeholder="H-2026-0412" aria-invalid={!!fieldError("lotNumber")} />
              </Field>
              <Field label="Supplier" error={fieldError("supplier")}>
                <input className="ui-input" value={draft.supplier} onChange={(e) => set("supplier", e.target.value)} />
              </Field>
              <Field label="Received" error={fieldError("receivedAt")}>
                <input className="ui-input" type="date" max={today()} value={draft.receivedAt} onChange={(e) => set("receivedAt", e.target.value)} aria-invalid={!!fieldError("receivedAt")} />
              </Field>
            </div>
            <datalist id="material-names">
              {materialNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            {!creating && inUse && editable && (
              <p className="ui-field-hint" style={{ margin: "12px 0 0" }}>
                Already used on work orders: a correction here changes what their lots show. Every change is in the audit log.
              </p>
            )}
          </section>
        </fieldset>
      </form>

      {current && (
        <section className="ui-section">
          <h3 className="ui-section-title">Where used</h3>
          {usageError && <p className="ui-message ui-message-error">{usageError}</p>}
          {usage === null && !usageError ? (
            <p className="ui-field-hint">Loading…</p>
          ) : usage && usage.length === 0 ? (
            <p className="ui-field-hint" style={{ margin: 0 }}>
              Not used on any work order yet. Choose it in a work order's Material section.
            </p>
          ) : (
            <ul className="ui-mini-list">
              {(usage ?? []).map((u) => (
                <li key={u.workOrderId} style={{ alignItems: "center" }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {u.orderNumber} · {u.partName}
                    <span className="ui-sub">
                      {u.lot
                        ? `${u.lot.lotNumber} · ${u.lot.goodCount.toLocaleString()} good, ${u.lot.scrapCount.toLocaleString()} scrap (${scrapRate(u.lot.goodCount, u.lot.scrapCount)}) · ${formatDateTime(u.lot.completedAt)}${u.lot.machineName ? ` · ${u.lot.machineName}` : ""}`
                        : `${STATUS[u.workOrderStatus] ?? u.workOrderStatus} · no finished lot yet`}
                    </span>
                  </span>
                  {u.lot && (
                    <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={() => openLot(u.lot!.lotNumber)}>
                      Open lot
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </Drawer>
  );
}
