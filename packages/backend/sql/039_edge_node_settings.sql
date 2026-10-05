-- 039: edge node settings (e.g. the catch-up limit in minutes).
--
-- One JSON object per edge node; missing keys fall back to the defaults in
-- src/edge-node-settings.ts, so new settings need no migration. The agent
-- receives the resolved settings when it claims the node.
--
-- Idempotent (migrations re-run on every start).

ALTER TABLE edge_nodes ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edge_nodes_settings_is_object') THEN
    ALTER TABLE edge_nodes ADD CONSTRAINT edge_nodes_settings_is_object CHECK (jsonb_typeof(settings) = 'object');
  END IF;
END $$;
