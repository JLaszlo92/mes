-- 032: bejelentkezési próbálkozások korlátozása (auth-throttle.ts).
--
-- Egy sor = egy számláló. A kulcs a szabály és az azonosító, pl.
--   pair:<email>|<ip>   ugyanarról az IP-ről ugyanarra a fiókra
--   account:<email>     egy fiókra, bármely IP-ről
--   ip:<ip>             egy IP-ről, bármely fiókra
--   mfa:<userId>        MFA kódok egy felhasználóra
-- Az adatbázisban tárolódik, így egy backend-újraindítás nem oldja fel.
-- Idempotens.
CREATE TABLE IF NOT EXISTS auth_throttle (
  key               TEXT PRIMARY KEY,
  failures          INTEGER NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  locked_until      TIMESTAMPTZ
);
