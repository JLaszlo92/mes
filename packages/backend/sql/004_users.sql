-- RBAC alapok (PRD 5.8, 8.3). A role egy egyszerű CHECK constraint, nem
-- külön tábla — az öt szerep fixnek számít az MVP-ben, nem admin-
-- szerkeszthető adat, mint pl. a shift_definitions.
--
-- user_machine_scope a machines táblára hivatkozik FK-val (nem úgy, mint
-- az events.machine_id, ami szándékosan laza) — itt indokolt a szigor,
-- mert egy létező gép nélküli scope-bejegyzés értelmetlen lenne.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('operator','supervisor','maintenance','manager','admin')),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_machine_scope (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, machine_id)
);

-- Szerver-oldali session, nem JWT — egyetlen DELETE-tel visszavonható,
-- ami fontos, ha egy fiók kompromittálódik.
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);