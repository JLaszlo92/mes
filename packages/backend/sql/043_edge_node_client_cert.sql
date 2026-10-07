-- Expiry of the edge device's MQTT client certificate, reported by the agent
-- (v10 and later) with the claim and every heartbeat. NULL = not reported.
ALTER TABLE edge_nodes ADD COLUMN IF NOT EXISTS client_cert_expires_at timestamptz;
