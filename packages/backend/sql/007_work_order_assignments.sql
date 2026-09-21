-- Finomtervező: egy megbízás hozzárendelése egy géphez egy adott
-- időszakra. Ez az első tábla, ami valódi FK-val köti össze a
-- work_orders és machines táblákat — itt indokolt a szigor (egy
-- hozzárendelés nem létező megbízásra/gépre értelmetlen lenne),
-- szemben pl. az events.machine_id szándékosan laza kapcsolatával.
--
-- Nincs átfedés-ellenőrzés — a PRD kifejezetten kizárja a "full APS/
-- finite scheduling optimization"-t; ez kézi, egyszerű hozzárendelés.

CREATE TABLE IF NOT EXISTS work_order_assignments (
  id             TEXT PRIMARY KEY,
  work_order_id  TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  machine_id     TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  planned_start  TIMESTAMPTZ NOT NULL,
  planned_end    TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (planned_end > planned_start)
);

CREATE INDEX IF NOT EXISTS work_order_assignments_machine_idx ON work_order_assignments (machine_id, planned_start);
CREATE INDEX IF NOT EXISTS work_order_assignments_work_order_idx ON work_order_assignments (work_order_id);