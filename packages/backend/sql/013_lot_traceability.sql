-- Alapanyag-tételek — egyszerű nyilvántartás, NEM ERP-helyettesítő
-- raktárkezelés (azt a PRD minden fázisból kizárja).
CREATE TABLE IF NOT EXISTS material_lots (
  id             TEXT PRIMARY KEY,
  material_name  TEXT NOT NULL,
  lot_number     TEXT NOT NULL,
  supplier       TEXT,
  received_at    DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (material_name, lot_number)
);

-- Ez az EGYETLEN ténylegesen kézzel rögzített kapcsolat — a PRD maga
-- ismeri el, hogy alapanyag-fogyasztást csak egy ERP-integráció tudna
-- automatikusan követni.
CREATE TABLE IF NOT EXISTS work_order_material_consumption (
  id               TEXT PRIMARY KEY,
  work_order_id    TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  material_lot_id  TEXT NOT NULL REFERENCES material_lots(id) ON DELETE CASCADE,
  recorded_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (work_order_id, material_lot_id)
);

-- A tétel-genealógia — automatikusan generálódik egy munkarendelés
-- lezárásakor, nem külön adatbeviteli lépésként (PRD 5.10).
CREATE TABLE IF NOT EXISTS lots (
  id              TEXT PRIMARY KEY,
  lot_number      TEXT NOT NULL UNIQUE,
  work_order_id   TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  machine_id      TEXT REFERENCES machines(id) ON DELETE SET NULL,
  operator_email  TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  good_count      INTEGER NOT NULL DEFAULT 0,
  scrap_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);