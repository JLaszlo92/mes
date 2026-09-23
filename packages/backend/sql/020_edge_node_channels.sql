-- Az edge_nodes eredeti, egy-géphez-kötött oszlopait szétválasztjuk: a
-- node maga csak az azonosítást/token-t/heartbeat-et tartja, a tényleges
-- gép-hozzárendelések (akár több is egy node-hoz) külön táblában vannak.
ALTER TABLE edge_nodes DROP COLUMN IF EXISTS machine_id;
ALTER TABLE edge_nodes DROP COLUMN IF EXISTS signal_source;
ALTER TABLE edge_nodes DROP COLUMN IF EXISTS connection_config;
ALTER TABLE edge_nodes DROP COLUMN IF EXISTS status_mode;
ALTER TABLE edge_nodes DROP COLUMN IF EXISTS no_signal_timeout_seconds;
ALTER TABLE edge_nodes DROP COLUMN IF EXISTS accept_production_while_down;

CREATE TABLE IF NOT EXISTS edge_node_channels (
  id                            TEXT PRIMARY KEY,
  edge_node_id                  TEXT NOT NULL REFERENCES edge_nodes(id) ON DELETE CASCADE,
  machine_id                    TEXT REFERENCES machines(id) ON DELETE SET NULL,
  signal_source                 TEXT NOT NULL CHECK (signal_source IN ('simulated', 'gpio', 's7', 'opcua', 'modbus')),
  connection_config             JSONB NOT NULL DEFAULT '{}'::jsonb,
  status_mode                   TEXT NOT NULL DEFAULT 'status_bit' CHECK (status_mode IN ('status_bit', 'signal_presence')),
  no_signal_timeout_seconds     INTEGER NOT NULL DEFAULT 60,
  accept_production_while_down  BOOLEAN NOT NULL DEFAULT true,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS edge_node_channels_edge_node_idx ON edge_node_channels (edge_node_id);
CREATE INDEX IF NOT EXISTS edge_node_channels_machine_idx ON edge_node_channels (machine_id);