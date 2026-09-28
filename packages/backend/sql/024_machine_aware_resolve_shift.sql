CREATE OR REPLACE FUNCTION resolve_shift(p_machine_id TEXT, ts TIMESTAMPTZ)
RETURNS TABLE(shift_date DATE, shift_name TEXT) AS $$
  WITH machine_info AS (
    SELECT shift_pattern_id, calendar_id FROM machines WHERE id = p_machine_id
  ),
  matched AS (
    SELECT
      CASE
        WHEN sps.start_time <= sps.end_time THEN ts::date
        WHEN ts::time >= sps.start_time THEN ts::date
        ELSE (ts::date - INTERVAL '1 day')::date
      END AS s_date,
      sps.name AS s_name
    FROM shift_pattern_shifts sps, machine_info mi
    WHERE sps.shift_pattern_id = mi.shift_pattern_id
      AND (
        (sps.start_time <= sps.end_time AND ts::time >= sps.start_time AND ts::time < sps.end_time)
        OR
        (sps.start_time > sps.end_time AND (ts::time >= sps.start_time OR ts::time < sps.end_time))
      )
    LIMIT 1
  ),
  checked AS (
    SELECT m.s_date, m.s_name, cwd.is_working
    FROM matched m
    CROSS JOIN machine_info mi
    LEFT JOIN calendar_working_days cwd
      ON cwd.calendar_id = mi.calendar_id AND cwd.day_of_week = EXTRACT(DOW FROM m.s_date)
  )
  SELECT
    COALESCE((SELECT s_date FROM checked WHERE COALESCE(is_working, true)), ts::date),
    COALESCE((SELECT s_name FROM checked WHERE COALESCE(is_working, true)), 'off_shift')
$$ LANGUAGE sql STABLE;

-- Az "off_shift" alapértelmezett OEE-besorolása: kizárt (excluded), hogy
-- ne rontsa az elérhetőséget, ha egy gép jogosan van műszakon kívül.
INSERT INTO machine_status_definitions (id, machine_id, code, display_name, oee_category, color)
SELECT md5('global|off_shift'), NULL, 'off_shift', 'Off-shift', 'excluded', '#5b6b7a'
WHERE NOT EXISTS (
  SELECT 1 FROM machine_status_definitions WHERE machine_id IS NULL AND code = 'off_shift'
);