CREATE TABLE IF NOT EXISTS production_counts_hourly (
  machine_id    TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  bucket_start  TIMESTAMPTZ NOT NULL,
  good_count    INTEGER NOT NULL DEFAULT 0,
  scrap_count   INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (machine_id, bucket_start)
);

CREATE INDEX IF NOT EXISTS production_counts_hourly_machine_bucket_idx
  ON production_counts_hourly (machine_id, bucket_start);

-- Egyszeri, teljes visszatöltés a meglévő 1.7M+ soros történetből — ez a
-- séma bevezetésekor fut le egyszer, utána a periodikus kiértékelő
-- (production-rollup-evaluator.ts) tartja frissen.
INSERT INTO production_counts_hourly (machine_id, bucket_start, good_count, scrap_count)
SELECT
  machine_id,
  date_trunc('hour', "timestamp") AS bucket_start,
  COUNT(*) FILTER (WHERE payload->>'result' = 'good'),
  COUNT(*) FILTER (WHERE payload->>'result' = 'scrap')
FROM events
WHERE type = 'production_count'
GROUP BY machine_id, date_trunc('hour', "timestamp")
ON CONFLICT (machine_id, bucket_start) DO NOTHING;