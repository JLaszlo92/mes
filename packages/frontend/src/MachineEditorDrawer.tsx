import { useMemo, useState, type FormEvent } from "react";
import Drawer from "./ui/Drawer.js";
import Field from "./ui/Field.js";
import { apiFetch, API_BASE } from "./api.js";
import { ApiError, readJsonOrThrow, type Machine, type PlantHierarchy } from "./master-data.js";
import MachineDataSourceSection from "./MachineDataSourceSection.js";
import MachineRelatedSection from "./MachineRelatedSection.js";

export interface NamedOption {
  id: string;
  name: string;
}

/** Az űrlap állapota: a számmezők stringként, hogy üresen is hagyhatók legyenek. */
interface Draft {
  id: string;
  name: string;
  assetType: string;
  isActive: boolean;
  siteId: string;
  areaId: string;
  lineId: string;
  shiftPatternId: string;
  calendarId: string;
  autoOffshiftStatus: boolean;
  idealCycleTimeSeconds: string;
  microStopThresholdSeconds: string;
}

export type EditorTarget =
  | { mode: "edit"; machine: Machine }
  | { mode: "create"; copyOf?: Machine };

function draftFromMachine(m: Machine): Draft {
  return {
    id: m.id,
    name: m.name,
    assetType: m.assetType ?? "",
    isActive: m.isActive,
    siteId: m.siteId,
    areaId: m.areaId,
    lineId: m.lineId ?? "",
    shiftPatternId: m.shiftPatternId ?? "",
    calendarId: m.calendarId ?? "",
    autoOffshiftStatus: m.autoOffshiftStatus,
    idealCycleTimeSeconds: m.idealCycleTimeSeconds !== null ? String(m.idealCycleTimeSeconds) : "",
    microStopThresholdSeconds: String(m.microStopThresholdSeconds),
  };
}

function initialDraft(target: EditorTarget, hierarchy: PlantHierarchy, patterns: NamedOption[], calendars: NamedOption[]): Draft {
  if (target.mode === "edit") return draftFromMachine(target.machine);
  if (target.copyOf) {
    // Másolat: minden beállítás átjön, csak az azonosító új, és a név jelzi, hogy másolat.
    return { ...draftFromMachine(target.copyOf), id: "", name: `${target.copyOf.name} (copy)`, isActive: true };
  }
  const site = hierarchy.sites[0];
  const area = hierarchy.areas.find((a) => a.siteId === site?.id);
  return {
    id: "",
    name: "",
    assetType: "",
    isActive: true,
    siteId: site?.id ?? "",
    areaId: area?.id ?? "",
    lineId: "",
    shiftPatternId: patterns.find((p) => p.id === "default-pattern")?.id ?? patterns[0]?.id ?? "",
    calendarId: calendars.find((c) => c.id === "default-247")?.id ?? calendars[0]?.id ?? "",
    autoOffshiftStatus: false,
    idealCycleTimeSeconds: "",
    microStopThresholdSeconds: "60",
  };
}

type Payload = Record<string, string | number | boolean | null>;

/** Az API-nak küldött mezők. A telephely nem kerül bele: a részlegből származik. */
function toPayload(d: Draft): Payload {
  const cycle = d.idealCycleTimeSeconds.trim().replace(",", ".");
  const micro = d.microStopThresholdSeconds.trim();
  return {
    name: d.name.trim(),
    assetType: d.assetType.trim() || null,
    isActive: d.isActive,
    areaId: d.areaId,
    lineId: d.lineId || null,
    shiftPatternId: d.shiftPatternId,
    calendarId: d.calendarId,
    autoOffshiftStatus: d.autoOffshiftStatus,
    idealCycleTimeSeconds: cycle === "" ? null : Number(cycle),
    microStopThresholdSeconds: micro === "" ? NaN : Number(micro),
  };
}

const MACHINE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Gyors kliensoldali ellenőrzés, hogy a nyilvánvaló hibák kérés nélkül látsszanak. A szerver a mérvadó. */
function localErrors(d: Draft, creating: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (creating && !MACHINE_ID_RE.test(d.id.trim())) e.id = "1–64 characters: letters, digits, '.', '_' or '-'.";
  if (d.name.trim() === "") e.name = "Enter a name.";
  if (!d.areaId) e.areaId = "Choose an area.";
  const cycle = d.idealCycleTimeSeconds.trim().replace(",", ".");
  if (cycle !== "" && !(Number(cycle) > 0)) e.idealCycleTimeSeconds = "Enter a positive number of seconds, or leave empty.";
  const micro = Number(d.microStopThresholdSeconds);
  if (!Number.isInteger(micro) || micro < 0 || micro > 3600) e.microStopThresholdSeconds = "Whole seconds between 0 and 3600.";
  return e;
}

export default function MachineEditorDrawer({
  target,
  hierarchy,
  shiftPatterns,
  calendars,
  readOnly,
  onClose,
  onSaved,
}: {
  target: EditorTarget;
  hierarchy: PlantHierarchy;
  shiftPatterns: NamedOption[];
  calendars: NamedOption[];
  readOnly: boolean;
  onClose: () => void;
  onSaved: (machine: Machine, created: boolean) => void;
}) {
  const creating = target.mode === "create";
  const [initial] = useState(() => initialDraft(target, hierarchy, shiftPatterns, calendars));
  const [draft, setDraft] = useState<Draft>(initial);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<{ message: string; field?: string } | null>(null);

  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  const errors = localErrors(draft, creating);
  const hasErrors = Object.keys(errors).length > 0;
  const fieldError = (field: string) => (touched ? errors[field] : undefined) ?? (serverError?.field === field ? serverError.message : undefined);

  const areas = useMemo(() => hierarchy.areas.filter((a) => a.siteId === draft.siteId), [hierarchy, draft.siteId]);
  const lines = useMemo(() => hierarchy.lines.filter((l) => l.areaId === draft.areaId), [hierarchy, draft.areaId]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => {
      const next = { ...d, [key]: value };
      // A hierarchiában lefelé kiürül, ami már nem illik a szülőhöz.
      if (key === "siteId") {
        next.areaId = hierarchy.areas.find((a) => a.siteId === value)?.id ?? "";
        next.lineId = "";
      }
      if (key === "areaId") next.lineId = "";
      return next;
    });
    if (serverError) setServerError(null);
  }

  function requestClose() {
    if (saving) return;
    if (!readOnly && changed && !window.confirm(creating ? "Discard this new machine?" : "Discard unsaved changes?")) return;
    onClose();
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (hasErrors || readOnly) return;
    setSaving(true);
    setServerError(null);
    try {
      const payload = toPayload(draft);
      let res: Response;
      if (creating) {
        res = await apiFetch(`${API_BASE}/api/machine-registry`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: draft.id.trim(), ...payload }),
        });
      } else {
        // Csak a megváltozott mezők — az audit is csak ezeket rögzíti.
        const before = toPayload(initial);
        const changed = Object.fromEntries(Object.entries(payload).filter(([k, v]) => before[k] !== v));
        if (Object.keys(changed).length === 0) {
          onClose();
          return;
        }
        res = await apiFetch(`${API_BASE}/api/machine-registry/${encodeURIComponent(draft.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(changed),
        });
      }
      const machine = await readJsonOrThrow<Machine>(res);
      onSaved(machine, creating);
    } catch (err) {
      setServerError(err instanceof ApiError ? { message: err.message, field: err.field } : { message: String(err) });
    } finally {
      setSaving(false);
    }
  }

  const title = creating ? (target.copyOf ? `Copy of ${target.copyOf.name}` : "New machine") : draft.name || draft.id;
  const legacyLocation = target.mode === "edit" ? target.machine.location : target.copyOf?.location;
  const formId = "machine-editor-form";

  return (
    <Drawer
      title={title}
      subtitle={creating ? "The ID must match the machine ID the edge agent sends." : `ID ${draft.id}`}
      onRequestClose={requestClose}
      footer={
        readOnly ? (
          <>
            <span className="ui-field-hint" style={{ flex: 1 }}>
              Only admins and managers can change machines.
            </span>
            <button type="button" className="ui-btn" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <>
            <span className="ui-field-hint" style={{ flex: 1 }}>
              {!creating && changed ? "Unsaved changes" : ""}
            </span>
            <button type="button" className="ui-btn" onClick={requestClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={saving || (!creating && !changed)}>
              {saving ? "Saving…" : creating ? "Create machine" : "Save changes"}
            </button>
          </>
        )
      }
    >
      <form id={formId} onSubmit={save} noValidate>
        <fieldset disabled={readOnly || saving} style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
          {serverError && !serverError.field && <p className="ui-message ui-message-error">{serverError.message}</p>}

          <section className="ui-section">
            <h3 className="ui-section-title">General</h3>
            <div className="ui-grid-2">
              {creating && (
                <Field label="Machine ID" error={fieldError("id")} hint="Cannot be changed later.">
                  <input className="ui-input" value={draft.id} onChange={(e) => set("id", e.target.value)} placeholder="press-03" aria-invalid={!!fieldError("id")} />
                </Field>
              )}
              <Field label="Name" error={fieldError("name")}>
                <input className="ui-input" value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="Press 3" aria-invalid={!!fieldError("name")} />
              </Field>
              <Field label="Type" error={fieldError("assetType")}>
                <input className="ui-input" value={draft.assetType} onChange={(e) => set("assetType", e.target.value)} placeholder="Hydraulic press" />
              </Field>
            </div>
            <div style={{ marginTop: 12 }}>
              <label className="ui-check">
                <input type="checkbox" checked={draft.isActive} onChange={(e) => set("isActive", e.target.checked)} />
                Active
              </label>
              <span className="ui-field-hint" style={{ display: "block", marginTop: 4 }}>
                Deactivated machines keep their history but don't appear in selectors, reports or scheduling.
              </span>
            </div>
          </section>

          <section className="ui-section">
            <h3 className="ui-section-title">Location</h3>
            <div className="ui-grid-2">
              <Field label="Site">
                <select className="ui-select" value={draft.siteId} onChange={(e) => set("siteId", e.target.value)}>
                  {hierarchy.sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Area" error={fieldError("areaId")}>
                <select className="ui-select" value={draft.areaId} onChange={(e) => set("areaId", e.target.value)} aria-invalid={!!fieldError("areaId")}>
                  {areas.length === 0 && <option value="">No areas at this site</option>}
                  {areas.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Line" error={fieldError("lineId")} hint="Optional — standalone machines belong to the area only.">
                <select className="ui-select" value={draft.lineId} onChange={(e) => set("lineId", e.target.value)}>
                  <option value="">No line</option>
                  {lines.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {legacyLocation && (
              <p className="ui-field-hint" style={{ marginTop: 8 }}>
                Previous free-text location: “{legacyLocation}”. Sites, areas and lines replace it.
              </p>
            )}
          </section>

          <section className="ui-section">
            <h3 className="ui-section-title">Scheduling</h3>
            <div className="ui-grid-2">
              <Field label="Shift pattern" error={fieldError("shiftPatternId")}>
                <select className="ui-select" value={draft.shiftPatternId} onChange={(e) => set("shiftPatternId", e.target.value)}>
                  {shiftPatterns.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Calendar" error={fieldError("calendarId")}>
                <select className="ui-select" value={draft.calendarId} onChange={(e) => set("calendarId", e.target.value)}>
                  {calendars.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div style={{ marginTop: 12 }}>
              <label className="ui-check">
                <input type="checkbox" checked={draft.autoOffshiftStatus} onChange={(e) => set("autoOffshiftStatus", e.target.checked)} />
                Set status to off-shift automatically outside working time
              </label>
            </div>
          </section>

          <section className="ui-section">
            <h3 className="ui-section-title">Performance</h3>
            <div className="ui-grid-2">
              <Field label="Ideal cycle time (s)" error={fieldError("idealCycleTimeSeconds")} hint="Needed for the OEE performance rate.">
                <input
                  className="ui-input num"
                  inputMode="decimal"
                  value={draft.idealCycleTimeSeconds}
                  onChange={(e) => set("idealCycleTimeSeconds", e.target.value)}
                  aria-invalid={!!fieldError("idealCycleTimeSeconds")}
                />
              </Field>
              <Field label="Micro-stop threshold (s)" error={fieldError("microStopThresholdSeconds")} hint="Shorter stops are summarized, not explained one by one.">
                <input
                  className="ui-input num"
                  inputMode="numeric"
                  value={draft.microStopThresholdSeconds}
                  onChange={(e) => set("microStopThresholdSeconds", e.target.value)}
                  aria-invalid={!!fieldError("microStopThresholdSeconds")}
                />
              </Field>
            </div>
          </section>
        </fieldset>
      </form>
      {creating ? (
        <section className="ui-section">
          <h3 className="ui-section-title">Data source</h3>
          <p className="ui-field-hint">Save the machine first, then connect its data source here.</p>
        </section>
      ) : readOnly ? null : (
        <MachineDataSourceSection machineId={draft.id} />
      )}
      {!creating && !readOnly && <MachineRelatedSection machineId={draft.id} />}
    </Drawer>
  );
}
