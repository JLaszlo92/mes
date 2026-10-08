-- mfa_pending_logins held the raw pending-login token (sql/010) as its primary key. It now holds the SHA-256 hex of the token,
-- in the column token_hash, like sessions (sql/028). A raw value cannot be told from a hash (both are 64 hex characters),
-- so the pending logins (they live for minutes) are deleted once, when the column is renamed; the user logs in again.
-- Idempotent: after the rename the block does nothing.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'mfa_pending_logins' AND column_name = 'token'
  ) THEN
    DELETE FROM mfa_pending_logins;
    ALTER TABLE mfa_pending_logins RENAME COLUMN token TO token_hash;
  END IF;
END
$$;
