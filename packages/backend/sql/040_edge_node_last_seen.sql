-- 040: edge_nodes.last_seen_at = the last time the node's agent was in contact
-- (claim, heartbeat or clean release).
--
-- last_heartbeat_at cannot serve this purpose: it drives the online state and
-- the instance lease, so a clean shutdown clears it (the node must be offline
-- at once and the next start must not wait). The dashboard showed "last seen:
-- never" for a node that had just been stopped.
--
-- Idempotent (migrations re-run on every start).

ALTER TABLE edge_nodes ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- Nodes that are running now already have a heartbeat; start from it.
UPDATE edge_nodes SET last_seen_at = last_heartbeat_at
 WHERE last_seen_at IS NULL AND last_heartbeat_at IS NOT NULL;
