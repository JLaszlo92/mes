-- Az events tábla hypertable-lé alakításához (és a kapcsolódó egyedi
-- kényszerek átalakításához) korábban kézzel nyúltunk az élő
-- adatbázishoz — ez a migráció ugyanezt rögzíti idempotens módon, hogy
-- jövőbeli újraindítások és telepítések is helyesen hozzák létre.
-- Csak akkor épül újra, ha még nem (id, timestamp): a migrate.ts minden
-- induláskor újrafuttatja ezt a fájlt, és a feltétel nélküli DROP + ADD
-- minden újraindításkor a teljes events tábla elsődleges kulcsát építette
-- újra (a tábla zárolva, amíg tart — egyre lassuló indulás).
DO $$
DECLARE
  pk_cols text[];
BEGIN
  SELECT array_agg(a.attname::text ORDER BY k.ord) INTO pk_cols
  FROM pg_constraint c
  CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
  WHERE c.conrelid = 'public.events'::regclass AND c.contype = 'p';

  IF pk_cols IS DISTINCT FROM ARRAY['id', 'timestamp'] THEN
    ALTER TABLE events DROP CONSTRAINT IF EXISTS events_pkey;
    ALTER TABLE events ADD PRIMARY KEY (id, "timestamp");
  END IF;
END
$$;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_source_event_id_key;
DROP INDEX IF EXISTS events_source_event_id_idx;
CREATE UNIQUE INDEX IF NOT EXISTS events_source_event_id_timestamp_idx ON events (source_event_id, "timestamp");

SELECT create_hypertable('events', 'timestamp', migrate_data => true, if_not_exists => true);