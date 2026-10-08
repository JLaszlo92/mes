-- Events whose timestamp the ingestion guard replaced with the receive time (stamped more than
-- 60 s in the future). The unique index of `events` is (source_event_id, "timestamp"), so a
-- resend of such an event (lost ack) carries a different timestamp than the stored row and was
-- stored a second time. insertEvent now skips an event whose source_event_id is listed here.
-- A row per corrected event only (rare); rows older than the edge buffer's lifetime can be deleted.
CREATE TABLE IF NOT EXISTS event_timestamp_corrections (
  source_event_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
