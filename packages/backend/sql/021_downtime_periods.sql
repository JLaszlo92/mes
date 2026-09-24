CREATE TABLE IF NOT EXISTS downtime_periods (
  id                TEXT PRIMARY KEY,
  machine_id        TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  started_at        TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ NOT NULL,
  duration_seconds  NUMERIC NOT NULL,
  fault_report_id   TEXT REFERENCES fault_reports(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (machine_id, started_at)
);

CREATE INDEX IF NOT EXISTS downtime_periods_unexplained_idx ON downtime_periods (machine_id) WHERE fault_report_id IS NULL;