-- Egyedi, gép-specifikus (vagy globális, ha machine_id NULL) állapotnevek
-- a beépített 'running' és 'down' állapotokon felül. Minden egyedi
-- állapothoz OEE-besorolás tartozik: 'counts_as_down' (ugyanúgy rontja az
-- elérhetőséget, mint a down) vagy 'excluded' (tervezett leállás — kimarad
-- a számításból).
CREATE TABLE IF NOT EXISTS machine_status_definitions (
  id            TEXT PRIMARY KEY,
  machine_id    TEXT REFERENCES machines(id) ON DELETE CASCADE,
  code          TEXT NOT NULL CHECK (code NOT IN ('running', 'down')),
  display_name  TEXT NOT NULL,
  oee_category  TEXT NOT NULL CHECK (oee_category IN ('counts_as_down', 'excluded')),
  color         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Két külön unique index kell, mert a sima UNIQUE(machine_id, code) nem
-- védene a globális (NULL machine_id) duplikátumok ellen — a standard SQL
-- szerint két NULL sosem egyenlő egymással.
CREATE UNIQUE INDEX IF NOT EXISTS machine_status_definitions_machine_code_idx
  ON machine_status_definitions (machine_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS machine_status_definitions_global_code_idx
  ON machine_status_definitions (code) WHERE machine_id IS NULL;

-- A korábban kódba égetett 'idle' és 'changeover' állapotok migrálása
-- adatra. A changeover most 'excluded' lesz — ez valójában egy OEE-
-- pontosítás: egy tervezett átállás a klasszikus módszertan szerint nem
-- availability-veszteség, a korábbi kód viszont eddig annak számolta.
INSERT INTO machine_status_definitions (id, machine_id, code, display_name, oee_category, color)
VALUES
  ('global-idle', NULL, 'idle', 'Idle', 'counts_as_down', '#898781'),
  ('global-changeover', NULL, 'changeover', 'Changeover', 'excluded', '#eda100')
ON CONFLICT (code) WHERE machine_id IS NULL DO NOTHING;