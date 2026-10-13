-- 054: első darab mérés újra, amikor egy szüneteltetett megbízást folytatnak.
--
-- quality_plans.first_piece_on_resume — ha be van kapcsolva (és a tervben van
-- első darab mérés), a megbízás folytatásakor új első darab ellenőrzés nyílik
-- (trigger = 'resume'); ha az első darab tiltja a számlálást, a folytatás után
-- addig a darabok sem számítanak. Alapból kikapcsolva: megbízásonként egyszer.
-- Idempotens.

ALTER TABLE quality_plans ADD COLUMN IF NOT EXISTS first_piece_on_resume BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'quality_checks'::regclass AND conname = 'quality_checks_trigger_check'
      AND pg_get_constraintdef(oid) LIKE '%resume%'
  ) THEN
    ALTER TABLE quality_checks DROP CONSTRAINT IF EXISTS quality_checks_trigger_check;
    ALTER TABLE quality_checks ADD CONSTRAINT quality_checks_trigger_check
      CHECK (trigger IN ('start', 'resume', 'complete', 'parts', 'time', 'manual'));
  END IF;
END
$$;
