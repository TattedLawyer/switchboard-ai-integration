import { getPool } from "../db.js";
import { catchUp } from "../backfill.js";
import { baseUrlFor, enabledSources } from "../sources.js";

async function main(): Promise<void> {
  const pool = getPool();
  let failed = false;

  for (const source of enabledSources()) {
    const baseUrl = baseUrlFor(source);
    try {
      const ingested = await catchUp(pool, source, baseUrl);
      console.log(`backfill[${source}]: ingested ${ingested} event(s) from ${baseUrl}`);
    } catch (err) {
      failed = true;
      console.error(`backfill[${source}] failed:`, err);

      // Read final cursor position to show resumable state
      try {
        const endRes = await pool.query(
          "select last_seq from ingest.cursors where source = $1",
          [source],
        );
        const endCursor = endRes.rowCount === 0 ? 0 : Number(endRes.rows[0].last_seq);
        console.log(`state is consistent; re-run to resume from cursor ${endCursor}`);
      } catch (cursorErr) {
        console.error("could not read cursor:", cursorErr);
      }
    }
  }

  await pool.end();
  process.exit(failed ? 1 : 0);
}

main();
