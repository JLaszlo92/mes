-- 049: kézzel (a terminálon) beállított gépállapot.
--
-- A dolgozó a terminálon egy Status definitions-beli állapotot állíthat be
-- (pl. "Beállítás", "Anyagra vár"). Ez machine_status eseményként kerül az
-- events táblába (így minden nézet, összesítő és az OEE ugyanúgy látja),
-- és addig érvényes, amíg a gép jele újra "running" nem lesz, a dolgozó le
-- nem zárja, vagy a műszak véget nem ér. Közben a gép többi jele
-- machine_status_signal típusként tárolódik (megmarad, de nem írja felül a
-- kézi állapotot). Egy gépen egyszerre egy aktív kézi állapot lehet.

CREATE TABLE IF NOT EXISTS machine_manual_status (
  id             TEXT PRIMARY KEY,
  machine_id     TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  status_code    TEXT NOT NULL,
  set_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  set_by_name    TEXT,
  terminal_id    TEXT,
  set_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The machine's own last status, kept up to date while the manual one is active,
  -- so that ending it can put the machine back to what its signal says.
  signal_status  TEXT,
  ended_at       TIMESTAMPTZ,
  end_reason     TEXT CHECK (end_reason IN ('signal_running', 'operator', 'replaced', 'off_shift')),
  ended_by       TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS machine_manual_status_active_idx ON machine_manual_status (machine_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS machine_manual_status_machine_idx ON machine_manual_status (machine_id, set_at DESC);

-- The new terminal permission, granted once to the roles that work at a machine.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_markers WHERE name = '049_terminal_set_status') THEN
    INSERT INTO role_permissions (role_id, permission)
    SELECT r.id, 'terminal.set_status' FROM roles r
    WHERE r.id IN ('operator', 'maintenance', 'maintenance_supervisor', 'quality_operator', 'quality_supervisor')
    ON CONFLICT DO NOTHING;
    INSERT INTO schema_markers (name) VALUES ('049_terminal_set_status');
  END IF;
END
$$;
