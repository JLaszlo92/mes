import { Pool } from "pg";
import { config } from "./config.js";

// A dashboard mára több panelt is egyszerre, párhuzamosan lekérdez
// (Overview: gépenként egy current-shift hívás, plusz machine-history,
// admin panelek stb.) — a korábbi, alacsony-konkurenciájú beszúró
// útvonalra méretezett 5-ös limit szűk keresztmetszetet okozott ez alatt.
export const pool = new Pool({ connectionString: config.databaseUrl, max: 20 });