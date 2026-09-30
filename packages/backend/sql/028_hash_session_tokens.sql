-- 028: a session tokenek helyett csak azok SHA-256 hash-e tárolódik.
--
-- Korábban a sessions.token a nyers bearer tokent tartalmazta, így aki az
-- adatbázist vagy egy mentést olvasni tudja, érvényes bejelentkezéseket
-- (admin sessionöket is, az MFA megkerülésével) kapott volna. A tokenek
-- 256 bites véletlen értékek, ezért sima SHA-256 elég (lassú jelszó-hash
-- nem kell). A meglévő sessionök helyben hash-elődnek, senki nem lép ki.
--
-- IDEMPOTENS: a migrate.ts minden induláskor az összes .sql fájlt
-- újrafuttatja. A blokk csak akkor fut, ha a régi "token" oszlop még létezik,
-- különben minden újraindítás újra hash-elné a hash-eket, és mindenkit
-- kiléptetne. A DO blokk egyetlen utasítás, így atomikus.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'token'
  ) THEN
    DELETE FROM sessions WHERE expires_at <= now();
    UPDATE sessions SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex');
    ALTER TABLE sessions RENAME COLUMN token TO token_hash;
  END IF;
END
$$;