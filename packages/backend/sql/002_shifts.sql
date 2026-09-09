-- Konfigurálható műszak-definíciók (PRD 5.7). Ez adat, nem kód — pont
-- azért, hogy a műszakok később szerkeszthetők legyenek (pl. egy admin
-- felületről) újratelepítés nélkül. Ez a migráció csak az alapértelmezett
-- értékeket adja meg, nem égeti be őket a lekérdezés-logikába.
--
-- start_time > end_time azt jelenti, hogy a műszak átnyúlik éjfélen (pl.
-- night: 22:00-06:00) — a resolve_shift() lent mindkét esetet kezeli.

CREATE TABLE IF NOT EXISTS shift_definitions (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  start_time TIME NOT NULL,
  end_time   TIME NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO shift_definitions (name, start_time, end_time) VALUES
  ('day', '06:00', '14:00'),
  ('afternoon', '14:00', '22:00'),
  ('night', '22:00', '06:00')
ON CONFLICT (name) DO NOTHING;

-- Egy tetszőleges timestampet a hozzá tartozó műszak-"instanciára" old fel.
-- Az instancia kulcsa (shift_date, shift_name), ahol a shift_date mindig az
-- a naptári nap, amikor a műszak ELKEZDŐDÖTT — így az éjszakai műszak,
-- ami D napon 22:00-kor kezdődik és D+1 napon 06:00-kor ér véget, EGY
-- instancia, (D, 'night'), nem két külön napra vágva.
CREATE OR REPLACE FUNCTION resolve_shift(ts TIMESTAMPTZ)
RETURNS TABLE(shift_date DATE, shift_name TEXT) AS $$
  SELECT
    CASE
      WHEN sd.start_time <= sd.end_time THEN ts::date
      WHEN ts::time >= sd.start_time THEN ts::date
      ELSE (ts::date - INTERVAL '1 day')::date
    END,
    sd.name
  FROM shift_definitions sd
  WHERE sd.is_active
    AND (
      (sd.start_time <= sd.end_time AND ts::time >= sd.start_time AND ts::time < sd.end_time)
      OR
      (sd.start_time > sd.end_time AND (ts::time >= sd.start_time OR ts::time < sd.end_time))
    )
  LIMIT 1;
$$ LANGUAGE sql STABLE;