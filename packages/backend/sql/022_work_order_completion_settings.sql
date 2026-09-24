-- Ezt a k\u00e9t oszlopot most vezetjük be, de csak a 2-3. l\u00e9p\u00e9sben fogjuk
-- ténylegesen felhasználni (automatikus lezárás, túltermelés-kezelés) —
-- az alapértelmezett értékek pontosan a mai viselkedést tükrözik.
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS completion_mode TEXT NOT NULL DEFAULT 'manual' CHECK (completion_mode IN ('manual', 'auto'));
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS count_overproduction BOOLEAN NOT NULL DEFAULT true;