-- Gyártási megbízás törzsadat. Az order_number az operátor/ERP felé
-- látható, olvasható azonosító — az id továbbra is a belső, UUID-alapú
-- technikai kulcs, ugyanúgy, ahogy a machines és users tábláknál is.
--
-- Ez a tábla csak azt írja le, MIT kell gyártani (termék, darabszám,
-- elvárt ciklusidő, határidő) — a "melyik gépre, mikor" a következő
-- lépésben (finomtervező, work_order_assignments tábla) kerül külön.

CREATE TABLE IF NOT EXISTS work_orders (
  id                            TEXT PRIMARY KEY,
  order_number                  TEXT NOT NULL UNIQUE,
  part_name                     TEXT NOT NULL,
  quantity                      INTEGER NOT NULL,
  expected_cycle_time_seconds   NUMERIC,
  due_date                      DATE,
  status                        TEXT NOT NULL DEFAULT 'planned'
                                   CHECK (status IN ('planned', 'released', 'in_progress', 'completed', 'cancelled')),
  notes                         TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS work_orders_status_idx ON work_orders (status);