-- 034: gépenkénti mikroleállási küszöb.
--
-- A küszöb alatti leállások "mikroleállások": nem kell őket egyenként
-- megmagyarázni (a magyarázatlan listán nem jelennek meg), hanem gépenként
-- összesítve látszanak (darab, összidő). A küszöb feletti leállások kerülnek
-- a magyarázandó listára és a Pareto-elemzésbe. Alapértelmezés: 60 mp.
-- Idempotens.
ALTER TABLE machines ADD COLUMN IF NOT EXISTS micro_stop_threshold_seconds INTEGER NOT NULL DEFAULT 60;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.machines'::regclass AND conname = 'machines_micro_stop_threshold_range'
  ) THEN
    ALTER TABLE machines ADD CONSTRAINT machines_micro_stop_threshold_range
      CHECK (micro_stop_threshold_seconds BETWEEN 0 AND 3600);
  END IF;
END
$$;

-- Az összesítő (ended_at szerinti időablak) és a magyarázatlan lista
-- (legújabbak elöl) indexei.
CREATE INDEX IF NOT EXISTS downtime_periods_machine_ended_idx ON downtime_periods (machine_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS downtime_periods_unexplained_started_idx
  ON downtime_periods (started_at DESC) WHERE fault_report_id IS NULL;
