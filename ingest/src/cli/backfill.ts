import { getPool } from "../db.js";
import { catchUp } from "../backfill.js";

async function main(): Promise<void> {
  const baseUrl = process.env.CRM_BASE_URL ?? "http://localhost:4001";
  const pool = getPool();
  try {
    const ingested = await catchUp(pool, baseUrl);
    console.log(`backfill: ingested ${ingested} event(s) from ${baseUrl}`);
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("backfill failed:", err);
    await pool.end();
    process.exit(1);
  }
}

main();
