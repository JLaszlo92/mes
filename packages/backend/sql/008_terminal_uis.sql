-- Egy "terminál UI" egy fizikai kioszk/tablet reprezentációja, ami egy
-- vagy több géphez tartozhat (pl. egy tablet két szomszédos gép között).
-- A many-to-many kapcsolat miatt külön kapcsolótábla kell.

CREATE TABLE IF NOT EXISTS terminal_uis (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS terminal_ui_machines (
  terminal_ui_id TEXT NOT NULL REFERENCES terminal_uis(id) ON DELETE CASCADE,
  machine_id     TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  PRIMARY KEY (terminal_ui_id, machine_id)
);