-- 051: minőségellenőrzés (quality plans, checks, measurements).
--
-- Egy part-hoz (work_orders.part_name, mint a munkautasításoknál) egy
-- verziózott ellenőrzési terv tartozik: első darab, utolsó darab és
-- szúrópróba, mindhárom opcionális. A terv mérési jellemzőket tartalmaz
-- (név, névleges érték, alsó/felső tűrés, mértékegység, PDF rajz), és
-- jellemzőnként megadható, melyik ellenőrzésben szerepel.
--
-- Egy ellenőrzés (quality_checks) egy munkarendelés egy konkrét eseménye
-- (indítás → első darab, N darab / max. idő → szúrópróba, lezárás →
-- utolsó darab). A mérések (quality_measurements) minden próbálkozást
-- megőriznek, a tűréshatárokat a mérés pillanatában rögzítve, így egy
-- későbbi tervmódosítás nem írja át a múltat.
--
-- A PDF-ek a munkautasítások fájltárában vannak (work_instruction_files).
-- Idempotens (migrate.ts minden indításkor lefuttatja).

CREATE TABLE IF NOT EXISTS quality_plans (
  id                           TEXT PRIMARY KEY,
  part_name                    TEXT NOT NULL,
  version                      INTEGER NOT NULL,
  is_current                   BOOLEAN NOT NULL DEFAULT true,
  -- false: the part has no quality plan any more (archived); a new version turns it on again.
  is_active                    BOOLEAN NOT NULL DEFAULT true,
  first_piece_enabled          BOOLEAN NOT NULL DEFAULT false,
  -- Parts are not counted until the first-piece check passes (or a supervisor releases it).
  first_piece_gates_counting   BOOLEAN NOT NULL DEFAULT true,
  last_piece_enabled           BOOLEAN NOT NULL DEFAULT false,
  -- The work order cannot be completed until the last-piece check passes (or is released).
  last_piece_gates_completion  BOOLEAN NOT NULL DEFAULT true,
  spot_enabled                 BOOLEAN NOT NULL DEFAULT false,
  spot_every_parts             INTEGER CHECK (spot_every_parts IS NULL OR spot_every_parts > 0),
  -- The longest time between two spot checks: when it is up, a check is raised in any case.
  spot_max_minutes             INTEGER CHECK (spot_max_minutes IS NULL OR spot_max_minutes > 0),
  -- An open spot check older than this raises the "quality check overdue" alert.
  spot_grace_minutes           INTEGER NOT NULL DEFAULT 15 CHECK (spot_grace_minutes > 0),
  notes                        TEXT,
  created_by                   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (part_name, version),
  CHECK (NOT spot_enabled OR spot_every_parts IS NOT NULL OR spot_max_minutes IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS quality_plans_current_idx ON quality_plans (part_name) WHERE is_current;

CREATE TABLE IF NOT EXISTS quality_characteristics (
  id               TEXT PRIMARY KEY,
  plan_id          TEXT NOT NULL REFERENCES quality_plans(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  name             TEXT NOT NULL,
  -- variable: a measured number between limits; attribute: OK / not OK (visual, go/no-go gauge).
  kind             TEXT NOT NULL CHECK (kind IN ('variable', 'attribute')),
  nominal          NUMERIC,
  lower_limit      NUMERIC,
  upper_limit      NUMERIC,
  unit             TEXT,
  -- Gauge / method, shown with the measurement.
  method           TEXT,
  pdf_file_id      TEXT REFERENCES work_instruction_files(id) ON DELETE RESTRICT,
  pdf_file_name    TEXT,
  in_first_piece   BOOLEAN NOT NULL DEFAULT true,
  in_last_piece    BOOLEAN NOT NULL DEFAULT true,
  in_spot          BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (plan_id, seq),
  CHECK (kind = 'attribute' OR lower_limit IS NOT NULL OR upper_limit IS NOT NULL),
  CHECK (lower_limit IS NULL OR upper_limit IS NULL OR lower_limit <= upper_limit)
);
CREATE INDEX IF NOT EXISTS quality_characteristics_file_idx ON quality_characteristics (pdf_file_id) WHERE pdf_file_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS quality_checks (
  id                  TEXT PRIMARY KEY,
  work_order_id       TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  machine_id          TEXT REFERENCES machines(id) ON DELETE SET NULL,
  plan_id             TEXT NOT NULL REFERENCES quality_plans(id) ON DELETE RESTRICT,
  kind                TEXT NOT NULL CHECK (kind IN ('first_piece', 'last_piece', 'spot')),
  trigger             TEXT NOT NULL CHECK (trigger IN ('start', 'complete', 'parts', 'time', 'manual')),
  -- first piece: holds the counting while open; last piece: holds the completion.
  gating              BOOLEAN NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'failed', 'passed', 'released', 'skipped', 'missed')),
  -- Since when the check holds the part count (gating first piece: from the start; any check: from a failed measurement).
  hold_since          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at           TIMESTAMPTZ,
  closed_by           TEXT REFERENCES users(id) ON DELETE SET NULL,
  closed_by_name      TEXT,
  release_reason      TEXT
);
CREATE INDEX IF NOT EXISTS quality_checks_work_order_idx ON quality_checks (work_order_id, created_at);
CREATE INDEX IF NOT EXISTS quality_checks_created_idx ON quality_checks (created_at DESC);
CREATE INDEX IF NOT EXISTS quality_checks_active_idx ON quality_checks (machine_id) WHERE status IN ('open', 'failed');
-- One active check of a kind per work order.
CREATE UNIQUE INDEX IF NOT EXISTS quality_checks_one_active_idx ON quality_checks (work_order_id, kind) WHERE status IN ('open', 'failed');

CREATE TABLE IF NOT EXISTS quality_measurements (
  id                 TEXT PRIMARY KEY,
  check_id           TEXT NOT NULL REFERENCES quality_checks(id) ON DELETE CASCADE,
  characteristic_id  TEXT NOT NULL REFERENCES quality_characteristics(id) ON DELETE RESTRICT,
  attempt            INTEGER NOT NULL,
  value              NUMERIC,
  ok                 BOOLEAN,
  passed             BOOLEAN NOT NULL,
  -- The characteristic as it was measured (a later plan version does not rewrite this).
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL,
  nominal            NUMERIC,
  lower_limit        NUMERIC,
  upper_limit        NUMERIC,
  unit               TEXT,
  comment            TEXT,
  measured_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  measured_by_name   TEXT,
  terminal_id        TEXT,
  terminal_name      TEXT,
  measured_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (check_id, characteristic_id, attempt),
  CHECK ((kind = 'variable' AND value IS NOT NULL) OR (kind = 'attribute' AND ok IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS quality_measurements_characteristic_idx ON quality_measurements (characteristic_id, measured_at);

-- The new permissions, granted once (an admin may change them later in Roles and permissions).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_markers WHERE name = '051_quality_permissions') THEN
    INSERT INTO role_permissions (role_id, permission)
    SELECT r.id, 'quality.measure' FROM roles r WHERE r.id IN ('quality_operator', 'quality_supervisor')
    ON CONFLICT DO NOTHING;
    INSERT INTO role_permissions (role_id, permission)
    SELECT r.id, 'quality.release' FROM roles r WHERE r.id IN ('quality_supervisor')
    ON CONFLICT DO NOTHING;
    INSERT INTO role_permissions (role_id, permission)
    SELECT r.id, 'quality.plans' FROM roles r WHERE r.id IN ('quality_supervisor')
    ON CONFLICT DO NOTHING;
    INSERT INTO schema_markers (name) VALUES ('051_quality_permissions');
  END IF;
END
$$;
