-- 041: edge_nodes.clock_offset_ms = how far the device's clock is ahead of the
-- server's (negative = behind), measured at the last claim / heartbeat.
--
-- Event timestamps come from the device's clock. A wrong clock puts events in
-- the future or the past and hides real status changes (the current status is
-- the event with the latest timestamp), so the dashboard has to show it.
-- NULL = unknown (agent older than v7, or never connected).
--
-- Idempotent (migrations re-run on every start).

ALTER TABLE edge_nodes ADD COLUMN IF NOT EXISTS clock_offset_ms bigint;
