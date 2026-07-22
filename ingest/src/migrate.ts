import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type pg from "pg";
import { getPool } from "./db.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function runMigrations(pool: pg.Pool): Promise<void> {
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    await pool.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = getPool();
  runMigrations(pool).then(() => { console.log("migrated"); return pool.end(); });
}
