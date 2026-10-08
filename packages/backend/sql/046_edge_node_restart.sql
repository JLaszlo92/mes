-- "Restart agent" button of the dashboard: the request waits here until the agent sees it in a heartbeat answer
-- (or until the node claims again, which counts as a restart and clears it).
ALTER TABLE edge_nodes ADD COLUMN IF NOT EXISTS restart_requested_at timestamptz;
