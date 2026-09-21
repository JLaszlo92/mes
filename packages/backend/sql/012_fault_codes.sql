CREATE TABLE IF NOT EXISTS machine_fault_codes (
  id                TEXT PRIMARY KEY,
  machine_id        TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  code              TEXT NOT NULL,
  name              TEXT NOT NULL,
  signal_reference  TEXT,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (machine_id, code)
);

-- occurrence_count > 1 = tömbösített, utólagos lejelentés.
CREATE TABLE IF NOT EXISTS fault_reports (
  id                 TEXT PRIMARY KEY,
  machine_id         TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  fault_code_id      TEXT NOT NULL REFERENCES machine_fault_codes(id) ON DELETE CASCADE,
  occurrence_count   INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  comment            TEXT,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'modified', 'rejected')),
  reported_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  reported_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at        TIMESTAMPTZ,
  reviewer_note      TEXT
);

CREATE INDEX IF NOT EXISTS fault_reports_status_idx ON fault_reports (status);