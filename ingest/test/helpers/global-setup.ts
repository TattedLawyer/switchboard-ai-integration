// PRE-3 (#22): the sweeper's one call site — vitest's globalSetup, which runs once per
// `vitest run` before any suite.
//
// Deliberately best-effort. This reclaims disk on a dev instance; it is not a correctness
// gate, and a sweeper that can fail a green suite would be a strictly worse trade than the
// leak it fixes. So: no DATABASE_URL, an unreachable admin database, or a database that
// refuses to drop (someone is connected to it) are all logged and stepped over.
import pg from "pg";
import { shouldSweep } from "./sweep-test-dbs.js";

export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;

  const adminUrl = url.replace(/\/[^/?]*(\?|$)/, "/postgres$1");
  const admin = new pg.Pool({ connectionString: adminUrl });
  admin.on("error", () => {
    /* a dev instance that is not up is not this hook's problem */
  });
  try {
    const { rows } = await admin.query<{ datname: string }>(
      "select datname from pg_database where datistemplate = false",
    );
    // The predicate decides, not this loop. Every refusal — the named `switchboard`
    // database a concurrent session may own, scratch databases, adjacent-looking names,
    // anything still young — happens in shouldSweep, where it is pinned.
    const stale = rows.map((r) => r.datname).filter((n) => shouldSweep(n));
    for (const name of stale) {
      try {
        await admin.query(`drop database if exists "${name}" with (force)`);
        console.log(`[testdb-sweeper] dropped abandoned ephemeral database ${name}`);
      } catch (err) {
        console.warn(`[testdb-sweeper] left ${name} in place: ${String(err)}`);
      }
    }
  } catch (err) {
    console.warn(`[testdb-sweeper] skipped: ${String(err)}`);
  } finally {
    await admin.end().catch(() => {});
  }
}
