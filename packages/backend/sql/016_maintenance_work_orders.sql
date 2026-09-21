CREATE TABLE IF NOT EXISTS maintenance_work_orders (
  id            TEXT PRIMARY KEY,
  machine_id    TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'in_progress', 'closed')),
  assigned_to   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- A jövőbeli leállás-ok integrációhoz (3. lépés): honnan indult a
  -- munkarendelés (riasztásból, hibalejelentésből, megelőző ütemezésből,
  -- vagy kézzel). Egy source_type+source_id pár, nem három külön FK,
  -- mert három különböző táblára mutathat.
  source_type   TEXT CHECK (source_type IN ('alert', 'fault_report', 'preventive_schedule', 'manual')),
  source_id     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS maintenance_work_orders_status_idx ON maintenance_work_orders (status);
CREATE INDEX IF NOT EXISTS maintenance_work_orders_machine_idx ON maintenance_work_orders (machine_id);

CREATE TABLE IF NOT EXISTS maintenance_work_order_parts (
  id              TEXT PRIMARY KEY,
  work_order_id   TEXT NOT NULL REFERENCES maintenance_work_orders(id) ON DELETE CASCADE,
  part_name       TEXT NOT NULL,
  quantity        INTEGER NOT NULL DEFAULT 1,
  logged_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS maintenance_work_order_labor (
  id              TEXT PRIMARY KEY,
  work_order_id   TEXT NOT NULL REFERENCES maintenance_work_orders(id) ON DELETE CASCADE,
  performed_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  hours           NUMERIC NOT NULL CHECK (hours > 0),
  notes           TEXT,
  logged_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);