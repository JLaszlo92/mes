-- 031: háttérfeladatok életjele + gépfüggetlen (rendszer) riasztások.
--
-- job_status: egy ütemezett feladat (első: 'db_backup') minden futás végén
-- beírja az eredményét. A backend backup-health-evaluator.ts ebből riaszt,
-- ha a legutóbbi futás sikertelen, VAGY túl régen volt sikeres futás — így
-- az is kiderül, ha a timer le sem fut (dead man's switch).
--
-- alerts: eddig minden riasztás egy géphez és egy alert_rule-hoz kötődött
-- (mindkettő NOT NULL). A rendszerriasztásoknál (pl. mentés) egyik sincs;
-- a CHECK kikényszeríti, hogy vagy mindkettő ki van töltve, vagy egyik sem.
-- Egy rendszerriasztás-típusból egyszerre legfeljebb egy lehet nyitva.
--
-- Idempotens: IF NOT EXISTS / feltételes blokkok, a DROP NOT NULL
-- újrafuttatása no-op.

CREATE TABLE IF NOT EXISTS job_status (
  name             TEXT PRIMARY KEY,
  last_run_at      TIMESTAMPTZ NOT NULL,
  last_status      TEXT NOT NULL CHECK (last_status IN ('success', 'failure')),
  last_error       TEXT,
  last_success_at  TIMESTAMPTZ,
  last_detail      JSONB
);

ALTER TABLE alerts ALTER COLUMN machine_id DROP NOT NULL;
ALTER TABLE alerts ALTER COLUMN rule_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.alerts'::regclass AND conname = 'alerts_machine_rule_both_or_neither'
  ) THEN
    ALTER TABLE alerts ADD CONSTRAINT alerts_machine_rule_both_or_neither
      CHECK ((machine_id IS NULL) = (rule_id IS NULL));
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_system_idx
  ON alerts (type)
  WHERE resolved_at IS NULL AND machine_id IS NULL;
