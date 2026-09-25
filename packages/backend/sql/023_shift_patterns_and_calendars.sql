CREATE TABLE IF NOT EXISTS shift_patterns (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shift_pattern_shifts (
  id               TEXT PRIMARY KEY,
  shift_pattern_id TEXT NOT NULL REFERENCES shift_patterns(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  start_time       TIME NOT NULL,
  end_time         TIME NOT NULL,
  UNIQUE (shift_pattern_id, name)
);

CREATE TABLE IF NOT EXISTS calendars (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- day_of_week: 0=vasárnap ... 6=szombat (a Postgres EXTRACT(DOW)-jával egyezik)
CREATE TABLE IF NOT EXISTS calendar_working_days (
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  is_working  BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (calendar_id, day_of_week)
);

ALTER TABLE machines ADD COLUMN IF NOT EXISTS shift_pattern_id TEXT REFERENCES shift_patterns(id) ON DELETE SET NULL;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS calendar_id TEXT REFERENCES calendars(id) ON DELETE SET NULL;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS auto_offshift_status BOOLEAN NOT NULL DEFAULT false;

-- Alapértelmezett minta/naptár a meglévő globális shift_definitions-ből,
-- és minden meglévő gép hozzárendelése — semmi nem törik el.
INSERT INTO shift_patterns (id, name) VALUES ('default-pattern', 'Standard 3-shift')
  ON CONFLICT (name) DO NOTHING;

INSERT INTO shift_pattern_shifts (id, shift_pattern_id, name, start_time, end_time)
SELECT md5('default-pattern|' || sd.name), 'default-pattern', sd.name, sd.start_time, sd.end_time
FROM shift_definitions sd
ON CONFLICT (shift_pattern_id, name) DO NOTHING;

INSERT INTO calendars (id, name) VALUES ('default-247', '24/7')
  ON CONFLICT (name) DO NOTHING;

INSERT INTO calendar_working_days (calendar_id, day_of_week, is_working)
SELECT 'default-247', d, true FROM generate_series(0, 6) d
ON CONFLICT (calendar_id, day_of_week) DO NOTHING;

UPDATE machines SET shift_pattern_id = 'default-pattern' WHERE shift_pattern_id IS NULL;
UPDATE machines SET calendar_id = 'default-247' WHERE calendar_id IS NULL;