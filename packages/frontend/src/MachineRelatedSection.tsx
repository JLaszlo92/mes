import { useEffect, useState, type ReactNode } from "react";
import { api } from "./edge-channels.js";

interface Counts {
  active: number;
  total: number;
}
interface Related {
  faultCodes: Counts;
  alertRules: Counts & { globalActive: number };
  preventiveSchedules: Counts;
  terminals: { id: string; name: string }[];
}

const rowStyle = { display: "grid", gridTemplateColumns: "170px 1fr", gap: 12, padding: "8px 0", borderTop: "1px solid #f0efeb", alignItems: "baseline" };

function Row({ label, href, children, empty }: { label: string; href: string; children: ReactNode; empty?: boolean }) {
  return (
    <div style={rowStyle}>
      <a href={href} target="_blank" rel="noopener noreferrer" style={{ fontWeight: 600 }}>
        {label}
      </a>
      <span className={empty ? "ui-field-hint" : undefined}>{children}</span>
    </div>
  );
}

/**
 * "Related configuration" part of the machine editor: what is set up for this
 * machine in other admin views, with a link to each (opens in a new tab so the
 * editor and its unsaved changes stay). Read only.
 */
export default function MachineRelatedSection({ machineId }: { machineId: string }) {
  const [data, setData] = useState<Related | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<Related>(`/api/machine-registry/${encodeURIComponent(machineId)}/related`, "GET")
      .then((d) => alive && setData(d))
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [machineId]);

  const fc = data?.faultCodes;
  const ar = data?.alertRules;
  const pm = data?.preventiveSchedules;

  return (
    <section className="ui-section">
      <h3 className="ui-section-title">Related configuration</h3>
      {error && <p className="ui-message ui-message-error">{error}</p>}
      {!data && !error && <p className="ui-field-hint">Loading…</p>}
      {data && fc && ar && pm && (
        <>
          <Row label="Fault codes" href="/admin/fault-codes" empty={fc.total === 0}>
            {fc.total === 0
              ? "None defined - operators cannot give a reason for a fault on this machine."
              : `${fc.active} active${fc.total > fc.active ? ` (${fc.total - fc.active} inactive)` : ""}`}
          </Row>
          <Row label="Alert rules" href="/alerts/rules" empty={ar.active === 0 && ar.globalActive === 0}>
            {ar.active === 0 && ar.globalActive === 0
              ? "No active rules - a long stop or a high scrap rate raises no alert."
              : [ar.active > 0 ? `${ar.active} for this machine` : "none for this machine only", ar.globalActive > 0 ? `${ar.globalActive} apply to all machines` : ""]
                  .filter(Boolean)
                  .join(" · ")}
          </Row>
          <Row label="Preventive schedules" href="/maintenance/preventive" empty={pm.total === 0}>
            {pm.total === 0 ? "None." : `${pm.active} active${pm.total > pm.active ? ` (${pm.total - pm.active} inactive)` : ""}`}
          </Row>
          <Row label="Terminals" href="/admin/terminals" empty={data.terminals.length === 0}>
            {data.terminals.length === 0 ? "Not on any terminal - operators cannot report from this machine." : data.terminals.map((t) => t.name).join(", ")}
          </Row>
        </>
      )}
    </section>
  );
}
