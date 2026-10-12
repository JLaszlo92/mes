-- 050: egy állapot blokkolhatja a gyártást.
--
-- Status definitions → "Blocks production": ha egy kézzel (a terminálon)
-- beállított állapot blokkolja a gyártást, akkor amíg érvényes, a gép
-- "running" jele nem írja felül, és a beérkező darabok nem számítanak bele
-- a darabszámba (production_count_blocked eseményként tárolódnak). Ha nem
-- blokkolja, az első gyártási jel (running vagy egy darab) azonnal
-- visszaállítja a gépet gyártásba.

ALTER TABLE machine_status_definitions ADD COLUMN IF NOT EXISTS blocks_production BOOLEAN NOT NULL DEFAULT false;

-- A kézi állapot új lezárási oka: "production" — egy darab érkezett, a gép termel.
ALTER TABLE machine_manual_status DROP CONSTRAINT IF EXISTS machine_manual_status_end_reason_check;
ALTER TABLE machine_manual_status ADD CONSTRAINT machine_manual_status_end_reason_check
  CHECK (end_reason IN ('signal_running', 'production', 'operator', 'replaced', 'off_shift'));
