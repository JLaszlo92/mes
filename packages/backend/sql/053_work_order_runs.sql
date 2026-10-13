-- 053: megbízás szüneteltetése (lejelentés a gépről), végső darabszám, folytatás.
--
-- Egy megbízás egy vagy több "futásból" áll: egy futás a gépen töltött
-- szakasz az indítástól (vagy folytatástól) a lejelentésig. A lejelentéskor
-- a dolgozó megadja a jó darabszámot és a selejtet okonként; ha a jó
-- darabszám (az eddigi futásokkal együtt) eléri az előirányzottat, a
-- megbízás lezárul, különben 'paused' (szüneteltetett) státuszba kerül, és
-- ugyanazon a gépen később folytatható (új futás).
--
-- A megbízás haladása: a lezárt futások lejelentett darabszáma + a nyitott
-- futás alatt a gép által számolt darabok. A gép eseményei (OEE, műszak)
-- nem változnak; a lejelentéskor felvett új selejt a szokásos selejt-
-- lejelentésként (scrap_bookings + események) kerül be.
--
-- counted_*  — amit a gép (és a terminálon lejelentett selejt) számolt
-- reported_* — amit a dolgozó lejelentett (a megbízás ezt veszi át)
-- scrap_breakdown — [{code, name, quantity}] a futás selejtje okonként
-- Idempotens.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'work_orders'::regclass AND conname = 'work_orders_status_check'
      AND pg_get_constraintdef(oid) LIKE '%paused%'
  ) THEN
    ALTER TABLE work_orders DROP CONSTRAINT IF EXISTS work_orders_status_check;
    ALTER TABLE work_orders ADD CONSTRAINT work_orders_status_check
      CHECK (status IN ('planned', 'released', 'in_progress', 'paused', 'completed', 'cancelled'));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS work_order_runs (
  id               TEXT PRIMARY KEY,
  work_order_id    TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  machine_id       TEXT REFERENCES machines(id) ON DELETE SET NULL,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  started_by_name  TEXT,
  ended_at         TIMESTAMPTZ,
  end_reason       TEXT CHECK (end_reason IN ('paused', 'completed', 'cancelled')),
  counted_good     INTEGER,
  counted_scrap    INTEGER,
  reported_good    INTEGER,
  reported_scrap   INTEGER,
  scrap_breakdown  JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- true: the worker entered the numbers at the terminal; false: closed with the machine's count (auto, dashboard)
  reported_manually BOOLEAN NOT NULL DEFAULT false,
  ended_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  ended_by_name    TEXT,
  terminal_id      TEXT,
  terminal_name    TEXT,
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS work_order_runs_one_open_idx ON work_order_runs (work_order_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS work_order_runs_order_idx ON work_order_runs (work_order_id, started_at);
CREATE INDEX IF NOT EXISTS work_order_runs_open_idx ON work_order_runs (started_at) WHERE ended_at IS NULL;

-- Orders already running get their open run, from the moment they were started.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_markers WHERE name = '053_runs_backfill') THEN
    INSERT INTO work_order_runs (id, work_order_id, machine_id, started_at, started_by, started_by_name)
    SELECT gen_random_uuid()::text, wo.id,
           (SELECT woa.machine_id FROM work_order_assignments woa WHERE woa.work_order_id = wo.id ORDER BY woa.planned_start LIMIT 1),
           COALESCE(s.occurred_at, now()), s.actor_id, s.actor_name
    FROM work_orders wo
    LEFT JOIN LATERAL (
      SELECT al.occurred_at, u.id AS actor_id, COALESCE(u.display_name, u.email, al.actor_email) AS actor_name
      FROM audit_log al LEFT JOIN users u ON u.id = al.actor_id
      WHERE al.action = 'work_order_updated' AND al.target = wo.id AND al.details->>'status' = 'in_progress'
      ORDER BY al.occurred_at LIMIT 1
    ) s ON true
    WHERE wo.status = 'in_progress'
      AND NOT EXISTS (SELECT 1 FROM work_order_runs r WHERE r.work_order_id = wo.id);
    INSERT INTO schema_markers (name) VALUES ('053_runs_backfill');
  END IF;
END
$$;
