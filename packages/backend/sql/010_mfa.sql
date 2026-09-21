-- MFA (PRD 8.3): admin/manager szerepkörnek kötelező. A titok azonnal
-- eltárolódik regisztrációkor, de mfa_enabled csak a sikeres első kód
-- megerősítése után válik true-vá — egy félbehagyott beállítás nem zárja
-- ki a felhasználót semmiből.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT false;

-- Rövid élettartamú, csak az MFA-kód beküldésére jó token — nem session,
-- nem használható semmilyen más API-hívásra.
CREATE TABLE IF NOT EXISTS mfa_pending_logins (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);