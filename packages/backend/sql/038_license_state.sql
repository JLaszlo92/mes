-- 038: licenc-állapot (docs/LICENSING.md).
--
-- Egyetlen sor. max_serial: a legnagyobb eddig telepített és érvényesnek
-- talált licenc sorszáma (régebbi licencfájl nem cserélheti le). last_seen_at:
-- a legkésőbbi ismert idő — az óra visszaállítása nem hosszabbítja meg a
-- licencet, mert az ellenőrzés max(rendszeridő, last_seen_at)-tal számol.
--
-- Idempotens.

CREATE TABLE IF NOT EXISTS license_state (
  id           BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  max_serial   INTEGER NOT NULL DEFAULT 0,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  license_id   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO license_state (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;
