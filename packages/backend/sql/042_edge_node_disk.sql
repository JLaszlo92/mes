-- Disk of the edge device (the file system holding the event buffer), reported
-- by the agent (v9 and later) with the claim and every heartbeat.
ALTER TABLE edge_nodes ADD COLUMN IF NOT EXISTS disk_used_bytes bigint;
ALTER TABLE edge_nodes ADD COLUMN IF NOT EXISTS disk_avail_bytes bigint;
