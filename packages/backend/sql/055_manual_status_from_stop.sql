-- 055: a kézi állapot a megállás pillanatától számít.
--
-- Ha a gép jele szerint áll (nem gyárt), és még nincs kézi állapota, akkor a
-- terminálon kiválasztott állapot a megállástól érvényes (set_at = a megállás,
-- vagy az utolsó darab utáni pillanat), a köztes gépjel-események
-- (down, idle…) machine_status_signal típusúra változnak. Ha már van kézi
-- állapot, az új a kiválasztás pillanatától számít (mint eddig).
-- selected_at: mikor választották ki ténylegesen a terminálon.
-- Idempotens.

ALTER TABLE machine_manual_status ADD COLUMN IF NOT EXISTS selected_at TIMESTAMPTZ;
UPDATE machine_manual_status SET selected_at = set_at WHERE selected_at IS NULL;
ALTER TABLE machine_manual_status ALTER COLUMN selected_at SET DEFAULT now();
