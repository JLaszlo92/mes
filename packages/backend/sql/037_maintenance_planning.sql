-- 037: karbantartási munkarendelések tervezése (a gépek Gantt-diagramjához).
--
-- planned_start / planned_end: a tervezett karbantartási ablak (mindkettő
-- vagy egyik sem — CHECK). Ez az előkészítés ahhoz, hogy a karbantartás a
-- gyártási rendelések mellett ugyanazon a gépsoron jelenjen meg a Gantt-on.
-- Szándékosan EGY ablak (nem szegmensek, mint a gyártásnál): egy
-- karbantartás jellemzően nem bontható szét műszakokra, és pont a
-- műszakon kívüli időre is tervezhető.
--
-- priority: low | normal | high | urgent — a lista rendezéséhez és a
-- későbbi riasztási logikához.
--
-- IDEMPOTENS: ADD COLUMN IF NOT EXISTS; a kényszerek név szerint őrzöttek.

ALTER TABLE maintenance_work_orders ADD COLUMN IF NOT EXISTS planned_start TIMESTAMPTZ;
ALTER TABLE maintenance_work_orders ADD COLUMN IF NOT EXISTS planned_end TIMESTAMPTZ;
ALTER TABLE maintenance_work_orders ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.maintenance_work_orders'::regclass AND conname = 'mwo_planned_window') THEN
    ALTER TABLE maintenance_work_orders ADD CONSTRAINT mwo_planned_window CHECK (
      (planned_start IS NULL AND planned_end IS NULL)
      OR (planned_start IS NOT NULL AND planned_end IS NOT NULL AND planned_end > planned_start)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.maintenance_work_orders'::regclass AND conname = 'mwo_priority_values') THEN
    ALTER TABLE maintenance_work_orders ADD CONSTRAINT mwo_priority_values CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
  END IF;
END
$$;

-- A Gantt gépenként, időablakra kérdez majd.
CREATE INDEX IF NOT EXISTS mwo_machine_planned_idx ON maintenance_work_orders (machine_id, planned_start) WHERE planned_start IS NOT NULL;
