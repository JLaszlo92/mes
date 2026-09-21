CREATE TABLE IF NOT EXISTS preventive_maintenance_schedules (
  id                 TEXT PRIMARY KEY,
  machine_id         TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  trigger_type       TEXT NOT NULL CHECK (trigger_type IN ('calendar', 'usage_hours', 'part_count')),
  interval_value     NUMERIC NOT NULL CHECK (interval_value > 0),
  description        TEXT NOT NULL,
  last_triggered_at  TIMESTAMPTZ,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pm_schedules_machine_idx ON preventive_maintenance_schedules (machine_id);