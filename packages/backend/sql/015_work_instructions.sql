CREATE TABLE IF NOT EXISTS work_instructions (
  id           TEXT PRIMARY KEY,
  part_name    TEXT NOT NULL,
  version      INTEGER NOT NULL,
  content      TEXT NOT NULL,
  pdf_url      TEXT,
  is_current   BOOLEAN NOT NULL DEFAULT true,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (part_name, version)
);

-- Bizonyítja, melyik verziót mutatták melyik operátornak, mikor, melyik
-- munkarendeléshez (PRD 5.11: "provable which revision an operator was
-- shown and when").
CREATE TABLE IF NOT EXISTS work_instruction_views (
  id                    TEXT PRIMARY KEY,
  work_instruction_id   TEXT NOT NULL REFERENCES work_instructions(id) ON DELETE CASCADE,
  work_order_id         TEXT REFERENCES work_orders(id) ON DELETE SET NULL,
  viewed_by             TEXT REFERENCES users(id) ON DELETE SET NULL,
  viewed_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);