-- Az events tábla hypertable-lé alakításához (és a kapcsolódó egyedi
-- kényszerek átalakításához) korábban kézzel nyúltunk az élő
-- adatbázishoz — ez a migráció ugyanezt rögzíti idempotens módon, hogy
-- jövőbeli újraindítások és telepítések is helyesen hozzák létre.
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_pkey;
ALTER TABLE events ADD PRIMARY KEY (id, "timestamp");

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_source_event_id_key;
DROP INDEX IF EXISTS events_source_event_id_idx;
CREATE UNIQUE INDEX IF NOT EXISTS events_source_event_id_timestamp_idx ON events (source_event_id, "timestamp");

SELECT create_hypertable('events', 'timestamp', migrate_data => true, if_not_exists => true);