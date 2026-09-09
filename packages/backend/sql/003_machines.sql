-- Master data a gépekhez. Jelenleg a machine_id csak egy szabadon lebegő
-- string, ami az első esemény érkezésekor jön létre a state.ts-ben — ez a
-- tábla ad neki valódi identitást (név, típus, hely), a PRD 5.4
-- (eszköznyilvántartás) és 5.8 (jogosultság-szűkítés) előkészítéseként.
-- Szándékosan lapos (nincs plant/line hierarchia) — az egy későbbi,
-- additív lépés, nem újraírás, ha egyszer tényleg kell.
--
-- Az events tábla továbbra is sima string machine_id-t használ, nem FK-t:
-- egy gép küldhet adatot, mielőtt regisztrálva lenne itt (pl. same-day
-- install közben), a dashboardnak akkor is meg kell mutatnia valamit.

CREATE TABLE IF NOT EXISTS machines (
  id          TEXT PRIMARY KEY,   -- megegyezik az events.machine_id-vel
  name        TEXT NOT NULL,
  asset_type  TEXT,
  location    TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);