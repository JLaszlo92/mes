-- Korrekciós intézkedés nyomon követése (PRD 5.3): mit találtak, mit
-- tettek ellene, ki hagyta jóvá. Egy hibalejelentéshez több korrekciós
-- bejegyzés is tartozhat, mindegyik külön aláírható.
CREATE TABLE IF NOT EXISTS corrective_actions (
  id               TEXT PRIMARY KEY,
  fault_report_id  TEXT NOT NULL REFERENCES fault_reports(id) ON DELETE CASCADE,
  description      TEXT NOT NULL,
  performed_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  performed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  signed_off_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  signed_off_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS corrective_actions_fault_report_idx ON corrective_actions (fault_report_id);