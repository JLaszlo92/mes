-- 035: óránkénti státusz-összesítő (status-rollup-evaluator.ts).
--
-- Gépenként és óránként: hány másodpercet töltött a gép az egyes
-- állapotokban. A production_counts_hourly párja: azok a funkciók, amelyek
-- hosszú időszakra néznek vissza (karbantartási üzemóra, később gép-előzmény,
-- műszak-összesítő), ebből számolnak a nyers események helyett — így a nyers
-- események megőrzési ideje nem befolyásolja őket.
-- Idempotens.
CREATE TABLE IF NOT EXISTS machine_status_hourly (
  machine_id   TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  bucket_start TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL,
  seconds      NUMERIC NOT NULL CHECK (seconds >= 0 AND seconds <= 3600),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (machine_id, bucket_start, status)
);
