-- Biztonsági esemény napló (PRD 8.8). actor_id ON DELETE SET NULL, hogy a
-- napló akkor is megmaradjon, ha egy felhasználót később törölnének —
-- ezért van külön actor_email is, ami nem függ a users tábla állapotától.

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  details     JSONB,
  ip_address  TEXT
);

CREATE INDEX IF NOT EXISTS audit_log_occurred_at_idx ON audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_id_idx ON audit_log (actor_id);