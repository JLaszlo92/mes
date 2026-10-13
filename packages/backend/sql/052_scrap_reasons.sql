-- 052: selejtokok és a terminálon lejelentett selejt.
--
-- A selejtokok ugyanúgy épülnek fel, mint a Status definitions: globális
-- (minden gépre) és gépenkénti sorok; egy gépen a saját sora felülírja az
-- azonos kódú globálisat. A gép jele (production_count, result = scrap)
-- is hozhat okot (scrapReasonCode); a terminálon lejelentett selejt
-- scrap_bookings sor + darabonként egy production_count esemény, így minden
-- meglévő összesítő (óránkénti, műszak, rendelés, OEE) látja.
--
-- machines.scrap_booking_mode: hogyan számít a lejelentett selejt
--   reclassify  — a gép minden darabot jónak számol: a lejelentett darabok a
--                 jóból átkerülnek a selejtbe (az esemény reclassified = true,
--                 a jó darabszámból levonódik); a teljes darabszám nem változik
--   additional  — a lejelentett selejt a gép számlálója mellé jön (pl. a
--                 gépen kívül kiszórt darabok); a jó darabszám nem változik
-- Idempotens.

CREATE TABLE IF NOT EXISTS scrap_reasons (
  id          TEXT PRIMARY KEY,
  machine_id  TEXT REFERENCES machines(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS scrap_reasons_global_code_idx ON scrap_reasons (code) WHERE machine_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS scrap_reasons_machine_code_idx ON scrap_reasons (machine_id, code);

ALTER TABLE machines ADD COLUMN IF NOT EXISTS scrap_booking_mode TEXT NOT NULL DEFAULT 'reclassify';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'machines_scrap_booking_mode_chk') THEN
    ALTER TABLE machines ADD CONSTRAINT machines_scrap_booking_mode_chk CHECK (scrap_booking_mode IN ('reclassify', 'additional'));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS scrap_bookings (
  id              TEXT PRIMARY KEY,
  machine_id      TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  work_order_id   TEXT REFERENCES work_orders(id) ON DELETE SET NULL,
  reason_id       TEXT REFERENCES scrap_reasons(id) ON DELETE SET NULL,
  -- The reason as it was booked (a renamed or deleted reason does not rewrite the past).
  reason_code     TEXT NOT NULL,
  reason_name     TEXT NOT NULL,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  mode            TEXT NOT NULL CHECK (mode IN ('reclassify', 'additional')),
  note            TEXT,
  booked_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  booked_by_name  TEXT,
  terminal_id     TEXT,
  terminal_name   TEXT,
  booked_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scrap_bookings_machine_idx ON scrap_bookings (machine_id, booked_at DESC);
CREATE INDEX IF NOT EXISTS scrap_bookings_work_order_idx ON scrap_bookings (work_order_id) WHERE work_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scrap_bookings_booked_idx ON scrap_bookings (booked_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_markers WHERE name = '052_scrap_permission') THEN
    INSERT INTO role_permissions (role_id, permission)
    SELECT r.id, 'terminal.report_scrap' FROM roles r
    WHERE r.id IN ('operator', 'quality_operator', 'quality_supervisor')
    ON CONFLICT DO NOTHING;
    INSERT INTO schema_markers (name) VALUES ('052_scrap_permission');
  END IF;
END
$$;
