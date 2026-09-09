import { Pool } from "pg";
import { config } from "./config.js";

// A single shared pool for the process, sized small deliberately — this is
// a low-write-volume ingestion path (one row per machine event), not a
// high-concurrency web API.
export const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
