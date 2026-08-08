import { describe, expect, it } from "vitest";
import pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";

// ── Task F: the testdb cleanup flake (register, ESCALATED — twice-bitten) ───────────────
//
// The live failure (burn-wave PR CI run, 2026-08-01): 57P01 "terminating connection due
// to administrator command" on an EPHEMERAL database → unhandled pg-pool 'error' event →
// the whole Vitest run fails with ZERO test failures. The cascade: `drop database ...
// with (force)` (and any admin termination under load) kills backends whose pool still
// holds idle clients; node-postgres surfaces an idle client's death as a pool-level
// 'error' event, and an EventEmitter 'error' with no listener is a process crash.
//
// These tests reproduce the mechanism deterministically — no load, no race: terminate
// the ephemeral DB's backends out from under a live pool exactly the way a force-drop
// does, then require cleanup to succeed anyway, twice.

const adminPoolFor = (url: string): pg.Pool => {
  const adminUrl = url.replace(/\/[^/?]*(\?|$)/, "/postgres$1");
  return new pg.Pool({ connectionString: adminUrl });
};

describe("testdb cleanup is idempotent and termination-proof (register: 57P01 flake)", () => {
  it("an idle pooled connection killed by an administrator (the force-drop cascade, simulated exactly) must not crash the run — and cleanup still completes", async () => {
    const { pool, url, cleanup } = await freshTestDb();
    // Park an IDLE client in the pool: run one query and release. The pool keeps the
    // backend open — the exact state the 57P01 cascade hits.
    await pool.query("select 1");

    const dbName = new URL(url).pathname.slice(1);
    const admin = adminPoolFor(url);
    try {
      // The administrator command: terminate every backend on the ephemeral DB, the
      // same thing `drop database ... with (force)` does to survivors.
      await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
          where datname = $1 and pid <> pg_backend_pid()`,
        [dbName],
      );
      // Give the pool's idle client a beat to observe its death — this is where the
      // unhandled 'error' event fired pre-fix and crashed the run with no failing test.
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      await admin.end();
    }

    // Cleanup after the massacre must still succeed: the pool is torn down without
    // throwing, and the database is dropped.
    await expect(cleanup()).resolves.toBeUndefined();
  });

  it("cleanup is IDEMPOTENT: calling it twice is safe (afterEach + suite-teardown overlap must never turn into 'Called end on pool more than once')", async () => {
    const { pool, cleanup } = await freshTestDb();
    await pool.query("select 1");
    await cleanup();
    await expect(cleanup()).resolves.toBeUndefined();
  });

  it("cleanup drops the database even while ANOTHER connection sits on it (terminate-own-backends-before-DROP, not a bare DROP that would hang or 55006)", async () => {
    const { pool, url, cleanup } = await freshTestDb();
    await pool.query("select 1");
    // A second, independent client on the same ephemeral DB — the shape of a leaked
    // child-process connection or a straggler pool under full-suite load.
    const straggler = new pg.Client({ connectionString: url });
    await straggler.connect();
    straggler.on("error", () => {
      /* its death by termination is this test's expected outcome */
    });
    await straggler.query("select 1");

    await expect(cleanup()).resolves.toBeUndefined();

    // The database is genuinely gone.
    const dbName = new URL(url).pathname.slice(1);
    const admin = adminPoolFor(url);
    try {
      const res = await admin.query("select 1 from pg_database where datname = $1", [dbName]);
      expect(res.rowCount).toBe(0);
    } finally {
      await admin.end();
    }
  });
});
