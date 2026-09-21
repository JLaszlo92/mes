CREATE TABLE IF NOT EXISTS alert_rules (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL CHECK (type IN ('machine_down', 'scrap_rate')),
  machine_id     TEXT REFERENCES machines(id) ON DELETE CASCADE,  -- NULL = minden gépre vonatkozik
  threshold      NUMERIC NOT NULL,  -- machine_down: percek; scrap_rate: százalék (0-100)
  notify_roles   TEXT[] NOT NULL DEFAULT '{supervisor,manager}',
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerts (
  id               TEXT PRIMARY KEY,
  rule_id          TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  machine_id       TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  type             TEXT NOT NULL,
  message          TEXT NOT NULL,
  raised_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ,
  acknowledged_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS alerts_open_idx ON alerts (machine_id, rule_id) WHERE resolved_at IS NULL;