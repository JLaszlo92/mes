import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Runs every .sql file in sql/ in filename order (001_, 002_, ...). Each
 * file must be idempotent (CREATE TABLE IF NOT EXISTS, ON CONFLICT DO
 * NOTHING, etc.) since this runs on every startup, not just once.
 */
export async function runMigrations(): Promise<void> {
  const sqlDir = path.join(__dirname, "..", "sql");
  const files = readdirSync(sqlDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = readFileSync(path.join(sqlDir, file), "utf-8");
    await pool.query(sql);
  }
}