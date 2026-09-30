-- 036: üzemi hierarchia (ISA-95: Site → Area → Line/Work Center).
--
-- Telephely (sites) → részleg (areas) → gyártósor (lines). A gép a
-- részleghez KÖTELEZŐEN, a sorhoz OPCIONÁLISAN tartozik (önálló gép, pl.
-- mérőállomás, közvetlenül a részleg alatt lehet). A telephely a
-- részlegből származik, a gépen nincs külön tárolva.
--
-- Az ellentmondást (a gép sora egy másik részleghez tartozik, mint a gép)
-- az adatbázis zárja ki egy összetett FK-val:
--   (machines.line_id, machines.area_id) → lines(id, area_id)
-- MATCH SIMPLE miatt line_id IS NULL esetén nincs ellenőrzés. ON UPDATE
-- CASCADE: ha egy sort másik részlegbe helyeznek át, a gépei vele mennek
-- (a gép area_id-ja is frissül).
--
-- Minden hierarchia-FK ON DELETE RESTRICT — használatban lévő elem nem
-- törölhető, a route 409-et ad (a 030-as tanulság: SET NULL csendben
-- rontja el az adatot).
--
-- IDEMPOTENS (a migrate.ts minden induláskor újrafuttatja): a táblák
-- IF NOT EXISTS-szel jönnek létre; az alapértelmezett telephely/részleg
-- létrehozása és a meglévő gépek besorolása EGYSZER fut le, amikor a
-- machines.area_id oszlop még nem létezik. Nincs minden induláskor újrafutó
-- "UPDATE ... WHERE area_id IS NULL" (lásd 023 → 24/7 naptár hibája), így
-- az alapértelmezett elemek átnevezhetők és — ha kiürültek — törölhetők.
--
-- A machines.location (szabad szöveg) megmarad, de az új UI már nem írja;
-- a meglévő értékek tesztadatok, kézzel kell a sorokba rendezni őket.

CREATE TABLE IF NOT EXISTS sites (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sites_name_uniq ON sites (lower(name));

CREATE TABLE IF NOT EXISTS areas (
  id         TEXT PRIMARY KEY,
  site_id    TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS areas_site_name_uniq ON areas (site_id, lower(name));

CREATE TABLE IF NOT EXISTS lines (
  id         TEXT PRIMARY KEY,
  area_id    TEXT NOT NULL REFERENCES areas(id) ON DELETE RESTRICT,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Az összetett FK célja a machines táblából.
  CONSTRAINT lines_id_area_uniq UNIQUE (id, area_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS lines_area_name_uniq ON lines (area_id, lower(name));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'machines' AND column_name = 'area_id'
  ) THEN
    INSERT INTO sites (id, name) VALUES ('default-site', 'Main site') ON CONFLICT (id) DO NOTHING;
    INSERT INTO areas (id, site_id, name) VALUES ('default-area', 'default-site', 'General') ON CONFLICT (id) DO NOTHING;

    ALTER TABLE machines ADD COLUMN area_id TEXT;
    ALTER TABLE machines ADD COLUMN line_id TEXT;
    UPDATE machines SET area_id = 'default-area';
    ALTER TABLE machines ALTER COLUMN area_id SET NOT NULL;

    ALTER TABLE machines ADD CONSTRAINT machines_area_id_fkey
      FOREIGN KEY (area_id) REFERENCES areas(id) ON DELETE RESTRICT;
    ALTER TABLE machines ADD CONSTRAINT machines_line_area_fkey
      FOREIGN KEY (line_id, area_id) REFERENCES lines(id, area_id)
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS machines_area_idx ON machines (area_id);
CREATE INDEX IF NOT EXISTS machines_line_idx ON machines (line_id);
