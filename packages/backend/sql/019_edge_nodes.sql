-- Edge-node regisztráció: minden fizikai edge-agent folyamat egy sor itt,
-- egyedi, titkos tokennel (csak a hash-e tárolva). A current_session_id +
-- last_heartbeat_at pár adja a "max egyszer fut" garanciát: egy induló
-- edge-agent csak akkor veheti át a helyet, ha az előző session már
-- rég nem küldött életjelet.
CREATE TABLE IF NOT EXISTS edge_nodes (
  id                            TEXT PRIMARY KEY,
  name                          TEXT NOT NULL,
  machine_id                    TEXT REFERENCES machines(id) ON DELETE SET NULL,
  signal_source                 TEXT NOT NULL CHECK (signal_source IN ('simulated', 'gpio', 's7', 'opcua', 'modbus')),
  connection_config             JSONB NOT NULL DEFAULT '{}'::jsonb,
  status_mode                   TEXT NOT NULL DEFAULT 'status_bit' CHECK (status_mode IN ('status_bit', 'signal_presence')),
  no_signal_timeout_seconds     INTEGER NOT NULL DEFAULT 60,
  accept_production_while_down  BOOLEAN NOT NULL DEFAULT true,
  token_hash                    TEXT NOT NULL,
  current_session_id            TEXT,
  last_heartbeat_at             TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);