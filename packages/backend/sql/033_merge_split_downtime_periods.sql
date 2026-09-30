-- 033: a régi evaluator által felhasított leállási periódusok összevonása.
--
-- A régi downtime-periods-evaluator minden "down" eseményt külön periódus
-- kezdetének vett a következő eseményig, így egy "down → down → running"
-- sorozatból két, egymáshoz pontosan illeszkedő periódus lett
-- (a.ended_at = b.started_at). Ez a migráció az ilyen láncokat egy
-- periódusba vonja: az első periódus végét kitolja, a töredéket törli.
-- Ha csak a töredékhez tartozott magyarázat (fault_report_id), az átkerül.
--
-- Idempotens: ha nincs több illeszkedő pár, nem csinál semmit. A ciklus a
-- háromnál több darabra hasadt láncokat is végigviszi.
DO $$
DECLARE
  merged integer;
BEGIN
  LOOP
    WITH pair AS (
      SELECT DISTINCT ON (a.id) a.id AS head_id, b.id AS frag_id, b.ended_at, b.fault_report_id AS frag_report
      FROM downtime_periods a
      JOIN downtime_periods b ON b.machine_id = a.machine_id AND b.started_at = a.ended_at
      -- csak lánc-kezdő "a" (őt magát nem egy másik periódus folytatja), hogy egy körben ne ütközzenek
      WHERE NOT EXISTS (
        SELECT 1 FROM downtime_periods z WHERE z.machine_id = a.machine_id AND z.ended_at = a.started_at
      )
      ORDER BY a.id
    ),
    upd AS (
      UPDATE downtime_periods d
      SET ended_at = pair.ended_at,
          duration_seconds = EXTRACT(EPOCH FROM (pair.ended_at - d.started_at)),
          fault_report_id = COALESCE(d.fault_report_id, pair.frag_report)
      FROM pair WHERE d.id = pair.head_id
      RETURNING pair.frag_id
    )
    DELETE FROM downtime_periods WHERE id IN (SELECT frag_id FROM upd);
    GET DIAGNOSTICS merged = ROW_COUNT;
    EXIT WHEN merged = 0;
  END LOOP;
END
$$;
