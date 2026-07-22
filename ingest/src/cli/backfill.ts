import { getPool } from "../db.js";
import { catchUp, CRM_SOURCE } from "../backfill.js";

async function main(): Promise<void> {
  const baseUrl = process.env.CRM_BASE_URL ?? "http://localhost:4001";
  const pool = getPool();
  try {
    // Capture starting cursor before backfill
    const startRes = await pool.query(
      "select last_seq from ingest.cursors where source = $1",
      [CRM_SOURCE],
    );
    const startCursor = startRes.rowCount === 0 ? 0 : Number(startRes.rows[0].last_seq);

    const ingested = await catchUp(pool, CRM_SOURCE, baseUrl);
    console.log(`backfill: ingested ${ingested} event(s) from ${baseUrl}`);
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("backfill failed:", err);

    // Read final cursor position to show resumable state
    try {
      const endRes = await pool.query(
        "select last_seq from ingest.cursors where source = $1",
        [CRM_SOURCE],
      );
      const endCursor = endRes.rowCount === 0 ? 0 : Number(endRes.rows[0].last_seq);
      console.log(`state is consistent; re-run to resume from cursor ${endCursor}`);
    } catch (cursorErr) {
      console.error("could not read cursor:", cursorErr);
    }

    await pool.end();
    process.exit(1);
  }
}

main();
