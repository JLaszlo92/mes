-- 048: szerepek és jogosultságok, dolgozók (PIN), terminál-párosítás.
--
-- A régi, CHECK constrainttel rögzített öt szerep (004) helyett szerkeszthető
-- szerepek, szerepenként kiválasztható jogosultságokkal. A jogosultságok
-- listája a kódban van (src/permissions.ts); itt csak az odaítélésük.
-- Az admin szerep a kódban MINDEN jogosultságot megkap, itt nincs sora.
--
-- Idempotens (migrate.ts minden indításkor minden fájlt lefuttat): az
-- adatmódosító lépések egyszeri jelzőhöz (schema_markers) vagy a régi
-- állapot meglétéhez kötöttek.

CREATE TABLE IF NOT EXISTS schema_markers (
  name     TEXT PRIMARY KEY,
  done_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  is_system   BOOLEAN NOT NULL DEFAULT false,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

-- A rendszerszerepek mindig léteznek (a nevük átírható, ON CONFLICT nem írja vissza).
INSERT INTO roles (id, name, description, is_system, sort_order) VALUES
  ('operator',               'Operátor',                'Works at the machine terminal',                   true, 10),
  ('planner',                'Finomtervező',            'Plans and schedules production',                  true, 20),
  ('maintenance',            'Karbantartó',             'Maintenance technician',                           true, 30),
  ('maintenance_supervisor', 'Karbantartó supervisor',  'Plans and signs off maintenance',                  true, 40),
  ('quality_operator',       'Quality operátor',        'Reports faults and explains downtime',            true, 50),
  ('quality_supervisor',     'Quality supervisor',      'Reviews quality data and work instructions',      true, 60),
  ('viewer',                 'Felhasználó',             'Read-only access to the dashboard',               true, 70),
  ('admin',                  'Admin',                   'Everything, including users and configuration',   true, 80)
ON CONFLICT (id) DO NOTHING;

-- Alapértelmezett jogosultságok: EGYSZER, hogy egy admin által elvett jog
-- egy újraindításkor ne jöjjön vissza. (Az admin minden jogot a kódból kap.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_markers WHERE name = '048_default_role_permissions') THEN
    INSERT INTO role_permissions (role_id, permission)
    SELECT r, p FROM (VALUES
      ('operator', 'terminal.start_work_order'),
      ('operator', 'terminal.complete_work_order'),
      ('operator', 'terminal.report_fault'),
      ('operator', 'terminal.open_instructions'),

      ('planner', 'work_orders.manage'),
      ('planner', 'schedule.manage'),
      ('planner', 'materials.receive'),
      ('planner', 'materials.manage'),
      ('planner', 'materials.assign'),
      ('planner', 'terminal.open_instructions'),

      ('maintenance', 'maintenance.manage'),
      ('maintenance', 'faults.report'),
      ('maintenance', 'corrective.log'),
      ('maintenance', 'alerts.acknowledge'),
      ('maintenance', 'terminal.report_fault'),
      ('maintenance', 'terminal.open_instructions'),

      ('maintenance_supervisor', 'maintenance.manage'),
      ('maintenance_supervisor', 'maintenance.plan'),
      ('maintenance_supervisor', 'faults.report'),
      ('maintenance_supervisor', 'corrective.log'),
      ('maintenance_supervisor', 'corrective.sign_off'),
      ('maintenance_supervisor', 'alerts.acknowledge'),
      ('maintenance_supervisor', 'terminal.report_fault'),
      ('maintenance_supervisor', 'terminal.open_instructions'),

      ('quality_operator', 'faults.report'),
      ('quality_operator', 'downtime.explain'),
      ('quality_operator', 'corrective.log'),
      ('quality_operator', 'materials.receive'),
      ('quality_operator', 'terminal.report_fault'),
      ('quality_operator', 'terminal.open_instructions'),

      ('quality_supervisor', 'faults.report'),
      ('quality_supervisor', 'faults.review'),
      ('quality_supervisor', 'downtime.explain'),
      ('quality_supervisor', 'corrective.log'),
      ('quality_supervisor', 'corrective.sign_off'),
      ('quality_supervisor', 'instructions.manage'),
      ('quality_supervisor', 'instructions.view_log'),
      ('quality_supervisor', 'materials.receive'),
      ('quality_supervisor', 'materials.manage'),
      ('quality_supervisor', 'alerts.acknowledge'),
      ('quality_supervisor', 'terminal.report_fault'),
      ('quality_supervisor', 'terminal.open_instructions')
    ) AS d(r, p)
    ON CONFLICT DO NOTHING;
    INSERT INTO schema_markers (name) VALUES ('048_default_role_permissions');
  END IF;
END
$$;

-- Felhasználók: név, törzsszám, PIN; e-mail és jelszó csak a dashboardhoz kell.
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_number TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_lookup TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_set_at TIMESTAMPTZ;
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_pin_lookup_idx ON users (pin_lookup) WHERE pin_lookup IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_employee_number_idx ON users (lower(employee_number)) WHERE employee_number IS NOT NULL;

-- A régi szerepek átképezése, egyszer: a CHECK constraint (004) megléte jelzi a régi állapotot.
DO $$
DECLARE
  con text;
BEGIN
  SELECT c.conname INTO con
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
  WHERE c.conrelid = 'users'::regclass AND c.contype = 'c' AND a.attname = 'role'
  LIMIT 1;
  IF con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', con);
    UPDATE users SET role = CASE role
      WHEN 'manager' THEN 'admin'
      WHEN 'supervisor' THEN 'quality_supervisor'
      ELSE role END;
    UPDATE alert_rules SET notify_roles = ARRAY(
      SELECT DISTINCT CASE r WHEN 'manager' THEN 'admin' WHEN 'supervisor' THEN 'quality_supervisor' ELSE r END
      FROM unnest(notify_roles) AS r);
    ALTER TABLE alert_rules ALTER COLUMN notify_roles SET DEFAULT '{quality_supervisor,admin}';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_fkey') THEN
    ALTER TABLE users ADD CONSTRAINT users_role_fkey FOREIGN KEY (role) REFERENCES roles(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END
$$;

-- Dashboardra csak e-mail + jelszó párossal lehet belépni; egyik a másik nélkül értelmetlen.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_login_pair_chk') THEN
    ALTER TABLE users ADD CONSTRAINT users_login_pair_chk CHECK ((email IS NULL) = (password_hash IS NULL));
  END IF;
END
$$;

-- A PIN-keresőkulcs HMAC kulcsa (és más, a szerver által generált titkok).
CREATE TABLE IF NOT EXISTS app_secrets (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Terminál-párosítás: a tablet egy hosszú, véletlen eszköz-tokennel azonosítja magát
-- (bejelentkezés nélkül, újraindítás után is); itt csak a SHA-256-ja van.
ALTER TABLE terminal_uis ADD COLUMN IF NOT EXISTS device_token_hash TEXT;
ALTER TABLE terminal_uis ADD COLUMN IF NOT EXISTS paired_at TIMESTAMPTZ;
ALTER TABLE terminal_uis ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS terminal_uis_device_token_idx ON terminal_uis (device_token_hash) WHERE device_token_hash IS NOT NULL;
