/**
 * What is configured around one machine in other parts of the system, for the
 * "Related configuration" section of the machine editor. Pure (no db import).
 */
export interface RelatedCounts {
  active: number;
  total: number;
}

export interface MachineRelated {
  faultCodes: RelatedCounts;
  /** Rules for this machine; `globalActive` = active rules that apply to every machine. */
  alertRules: RelatedCounts & { globalActive: number };
  preventiveSchedules: RelatedCounts;
  terminals: { id: string; name: string }[];
}

const num = (v: unknown): number => {
  const n = Number(v); // pg returns count(*) as a string
  return Number.isFinite(n) ? n : 0;
};

export function shapeRelated(row: Record<string, unknown>, terminals: { id: string; name: string }[]): MachineRelated {
  return {
    faultCodes: { active: num(row.fc_active), total: num(row.fc_total) },
    alertRules: { active: num(row.ar_active), total: num(row.ar_total), globalActive: num(row.ar_global_active) },
    preventiveSchedules: { active: num(row.pm_active), total: num(row.pm_total) },
    terminals: terminals.map((t) => ({ id: t.id, name: t.name })),
  };
}
