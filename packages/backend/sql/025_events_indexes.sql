-- Az events tábla ~1.7 millió sornál tartott index nélkül — minden
-- időszak-alapú lekérdezés (shift-summary, machine-history, downtime-
-- periods, stb.) teljes táblaolvasást végzett emiatt.
CREATE INDEX IF NOT EXISTS events_machine_type_timestamp_idx ON events (machine_id, type, "timestamp");
CREATE INDEX IF NOT EXISTS events_type_timestamp_idx ON events (type, "timestamp");