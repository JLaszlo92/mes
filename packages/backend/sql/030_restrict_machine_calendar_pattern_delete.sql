-- 030: használatban lévő naptár vagy műszakminta nem törölhető.
--
-- A 023-ban a machines.calendar_id és machines.shift_pattern_id FK-ja
-- ON DELETE SET NULL volt, így egy géphez rendelt naptár/minta törlése
-- csendben kiürítette a gép hozzárendelését — majd a 023 minden induláskor
-- újrafutó "UPDATE ... SET calendar_id = 'default-247' WHERE calendar_id IS
-- NULL" sora szó nélkül 24/7-es naptárat adott a gépnek (nincs többé
-- műszakon kívüli idő, más alapon számolt availability és OEE).
-- RESTRICT mellett az adatbázis maga tiltja a törlést; a DELETE route ezt
-- 409-ként adja vissza ("still assigned to a machine").
--
-- IDEMPOTENS: a kényszert oszlop alapján keresi meg (a nevét nem
-- feltételezi), és csak akkor cseréli, ha még nem RESTRICT ('r').
DO $$
DECLARE
  spec record;
  fk_name text;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('calendar_id', 'calendars', 'machines_calendar_id_fkey'),
      ('shift_pattern_id', 'shift_patterns', 'machines_shift_pattern_id_fkey')
    ) AS t(col, ref_table, new_name)
  LOOP
    SELECT c.conname INTO fk_name
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.machines'::regclass
      AND c.contype = 'f'
      AND a.attname = spec.col
      AND c.confdeltype <> 'r'
    LIMIT 1;

    IF fk_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.machines DROP CONSTRAINT %I', fk_name);
      EXECUTE format(
        'ALTER TABLE public.machines ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(id) ON DELETE RESTRICT',
        spec.new_name, spec.col, spec.ref_table
      );
    END IF;
  END LOOP;
END
$$;
