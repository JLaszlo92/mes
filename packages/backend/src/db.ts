import { Pool, types } from "pg";
import type { FastifyBaseLogger } from "fastify";
import { config } from "./config.js";

// A dashboard mára több panelt is egyszerre, párhuzamosan lekérdez
// (Overview: gépenként egy current-shift hívás, plusz machine-history,
// admin panelek stb.) — a korábbi, alacsony-konkurenciájú beszúró
// útvonalra méretezett 5-ös limit szűk keresztmetszetet okozott ez alatt.
//
// Minden kapcsolat már a kapcsolódáskor a gyár időzónáját kapja
// (config.timezone), így a műszak-függvények (resolve_shift, off-shift
// szegmensek), a ::date / ::time konverziók és a naptári napok helyi időben
// értendők — függetlenül attól, mi az adatbázis alapértelmezése.
// DATE (OID 1082) → "YYYY-MM-DD" string, nem JS Date. Alapból a pg helyi
// éjfélként parse-olja, ami JSON-ban UTC-re fordítva az ELŐZŐ napot adta
// (pl. határidő 2026-10-05 → "2026-10-04T22:00:00.000Z"). Egy naptári nap
// nem időpont — stringként utazik végig.
types.setTypeParser(1082, (value: string) => value);

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  options: `-c timezone=${config.timezone}`,
});

// A tétlen (éppen nem használt) kapcsolatok hibáját a pg a pool "error"
// eseményén jelzi. Ha nincs rá figyelő, a Node-folyamat leáll: egy Postgres
// újraindítás (57P01) így az egész backendet lelőtte. A pool a következő
// lekérdezéskor új kapcsolatot nyit, ezért itt elég naplózni.
let lastPoolErrorLogMs = 0;
pool.on("error", (err: Error & { code?: string }) => {
  const now = Date.now();
  if (now - lastPoolErrorLogMs < 10_000) return;
  lastPoolErrorLogMs = now;
  console.error(`postgres pool: idle client error (${err.code ?? "no code"}): ${err.message} - the pool reconnects on the next query`);
});

/**
 * Az adatbázis ALAPÉRTELMEZETT időzónáját is a gyáréra állítja, ha eltér —
 * így a kézi psql lekérdezések is helyi időt mutatnak. A beállítást a
 * pg_dump nem menti, ezért egy mentésből visszaállított adatbázison az első
 * induláskor magától helyreáll. A backend működése ettől nem függ (a
 * kapcsolatok a fenti options-szel kapják az időzónát).
 */
export async function ensureDatabaseTimezone(log: FastifyBaseLogger): Promise<void> {
  try {
    const current = await pool.query<{ tz: string | null }>(
      `SELECT split_part(cfg, '=', 2) AS tz
       FROM pg_db_role_setting s
       JOIN pg_database d ON d.oid = s.setdatabase
       CROSS JOIN LATERAL unnest(s.setconfig) AS cfg
       WHERE d.datname = current_database() AND s.setrole = 0 AND lower(split_part(cfg, '=', 1)) = 'timezone'`,
    );
    const configured = current.rows[0]?.tz ?? null;
    if (configured === config.timezone) return;
    // A parancs szövegét az adatbázis állítja össze (%I / %L idézés), egy
    // lekérdezésben — a pool két lekérdezést két külön kapcsolaton is futtathat.
    const stmt = await pool.query<{ sql: string }>(
      `SELECT format('ALTER DATABASE %I SET timezone = %L', current_database(), $1::text) AS sql`,
      [config.timezone],
    );
    await pool.query(stmt.rows[0]!.sql);
    log.info({ timezone: config.timezone, previous: configured ?? "(server default)" }, "database default time zone set");
  } catch (err) {
    log.warn({ err }, "could not set the database default time zone (connections still use the configured one)");
  }
}
