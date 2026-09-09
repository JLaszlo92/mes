-- M0/M1 scope: a single generic events table holding every machine event as
-- JSONB, good enough to prove the edge-to-cloud pipeline end to end. Once
-- M2 (Production & Status Counting + OEE) needs to query at real volume,
-- this is the natural point to either add typed columns for the hot fields
-- or convert this table to a TimescaleDB hypertable
-- (`SELECT create_hypertable('events', 'timestamp')`) — both are additive
-- changes, not a rewrite, since source_event_id and the JSONB payload
-- already carry everything a typed table would need.
--
-- Migrations here are a single idempotent SQL file run at backend startup
-- (see src/migrate.ts) rather than a migration-tool/ORM, so there's nothing
-- to install beyond the `pg` driver itself — no native binaries to fetch at
-- build time. That matters beyond convenience: PRD Section 8.2 expects this
-- product to run inside a customer's segmented OT network, where outbound
-- access to arbitrary third-party binary hosts may simply not be allowed.
-- Revisit this choice (e.g. a proper migration tool) once schema changes
-- get frequent enough that hand-written idempotent SQL becomes a burden.

CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,
  machine_id      TEXT NOT NULL,
  type            TEXT NOT NULL,
  "timestamp"     TIMESTAMPTZ NOT NULL,
  source_event_id TEXT NOT NULL UNIQUE,
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_machine_id_timestamp_idx
  ON events (machine_id, "timestamp");
