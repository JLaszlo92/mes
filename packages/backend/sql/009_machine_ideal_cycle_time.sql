-- Az OEE Performance-komponenséhez szükséges "ideális ciklusidő"
-- gépenként. Nullable — ha nincs megadva, a Performance/OEE null marad,
-- nem hamis 100%-ot mutat.
ALTER TABLE machines ADD COLUMN IF NOT EXISTS ideal_cycle_time_seconds NUMERIC;