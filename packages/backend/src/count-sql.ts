/**
 * The good-part count in SQL, in one place. A scrap booked at the terminal on a machine in "reclassify" mode is a
 * production_count event with result = scrap and reclassified = true: the part was counted as good by the machine,
 * so it is taken off the good count here (and added to scrap by the event itself). Use these wherever parts of the
 * events table are counted.
 */
export function goodCountSql(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  return `(COUNT(*) FILTER (WHERE ${p}payload->>'result' = 'good') - COUNT(*) FILTER (WHERE ${p}payload->>'result' = 'scrap' AND ${p}payload->>'reclassified' = 'true'))`;
}

export function scrapCountSql(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  return `COUNT(*) FILTER (WHERE ${p}payload->>'result' = 'scrap')`;
}

/** Parts the machine made (a reclassified booking is not a new part). */
export function partsCountSql(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  return `COUNT(*) FILTER (WHERE COALESCE(${p}payload->>'reclassified', 'false') <> 'true')`;
}
