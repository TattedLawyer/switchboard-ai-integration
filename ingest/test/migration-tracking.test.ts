import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { runMigrations, appliedMigrations, MIGRATION_LOCK_KEYS } from "../src/migrate.js";

// G3 — migration tracking.
//
// Until now `migrate.ts` re-ran every file on every start, and correctness rested entirely on
// each migration being hand-proven idempotent (the 001-recreate / 003-drop dance is the
// clearest example). That works right up until it doesn't: nothing recorded what had been
// applied, so nothing could detect a migration that was edited after the fact, or one that
// failed halfway through. The failure mode is a database whose real shape silently differs
// from what the files say.
//
// What we want is modest and specific: a record of what ran, and a loud failure when an
// already-applied migration's contents change. Not a full migration framework.

let pool: pg.Pool;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
});
afterEach(async () => {
  await cleanup();
});

describe("migration tracking", () => {
  it("records every migration it applied, with a checksum", async () => {
    const applied = await appliedMigrations(pool);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.map((m) => m.filename)).toContain("006_tenancy.sql");
    for (const m of applied) {
      expect(m.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(m.applied_at).toBeInstanceOf(Date);
    }
  });

  it("is idempotent — a second run applies nothing new and does not duplicate rows", async () => {
    const before = await appliedMigrations(pool);
    await runMigrations(pool);
    const after = await appliedMigrations(pool);

    expect(after.length).toBe(before.length);
    expect(after.map((m) => m.filename)).toEqual(before.map((m) => m.filename));
    // The recorded timestamps must not move: a re-run should SKIP, not re-apply and re-stamp.
    expect(after.map((m) => m.applied_at.getTime())).toEqual(
      before.map((m) => m.applied_at.getTime()),
    );
  });

  it("REFUSES to run when an already-applied migration's contents have changed", async () => {
    // The scenario this exists for: someone edits a migration that has already run somewhere.
    // Re-running it is not an option (it may not be re-runnable) and ignoring it is worse —
    // the database and the repository now disagree and nothing says so. Fail loudly instead.
    await pool.query(
      "update ingest.schema_migrations set checksum = repeat('0', 64) where filename = $1",
      ["006_tenancy.sql"],
    );

    await expect(runMigrations(pool)).rejects.toThrow(/006_tenancy\.sql.*(changed|checksum)/i);
  });

  it("records migrations in filename order, so the applied history is readable", async () => {
    const applied = await appliedMigrations(pool);
    const names = applied.map((m) => m.filename);
    expect(names).toEqual([...names].sort());
  });
});

describe("concurrent-boot advisory lock (close F14) — session lock on ONE dedicated client, held for the whole run, always released", () => {
  const KEYS = MIGRATION_LOCK_KEYS;

  it("runMigrations WAITS while another session holds the migration lock, and proceeds when it is released — two racing boots serialize instead of interleaving DDL", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("select pg_advisory_lock($1, $2)", [...KEYS]);
      let finished = false;
      const run = runMigrations(pool).then(() => {
        finished = true;
      });
      // Long enough that an un-locked runMigrations (all files already applied → pure
      // reads) would have finished many times over.
      await new Promise((r) => setTimeout(r, 500));
      expect(finished, "runMigrations completed while the migration lock was HELD — no lock was taken, or it was taken on a different pooled connection than the one running the migrations (the pool.query no-op the research names)").toBe(false);
      await holder.query("select pg_advisory_unlock($1, $2)", [...KEYS]);
      await run;
      expect(finished).toBe(true);
    } finally {
      holder.release();
    }
  });

  it("releases the lock on SUCCESS (try/finally): immediately after runMigrations returns, another session can take it", async () => {
    await runMigrations(pool);
    const probe = await pool.connect();
    try {
      const res = await probe.query("select pg_try_advisory_lock($1, $2) as got", [...KEYS]);
      expect(res.rows[0].got, "the migration lock is still held after a successful run — a leaked session lock deadlocks every future boot").toBe(true);
      await probe.query("select pg_advisory_unlock($1, $2)", [...KEYS]);
    } finally {
      probe.release();
    }
  });

  it("releases the lock on FAILURE too — a refused run must not deadlock the next boot", async () => {
    const prev = process.env.DBT_SCHEMA;
    process.env.DBT_SCHEMA = "Not A Valid Identifier!";
    try {
      await expect(runMigrations(pool)).rejects.toThrow(/invalid DBT_SCHEMA/);
    } finally {
      if (prev === undefined) delete process.env.DBT_SCHEMA;
      else process.env.DBT_SCHEMA = prev;
    }
    const probe = await pool.connect();
    try {
      const res = await probe.query("select pg_try_advisory_lock($1, $2) as got", [...KEYS]);
      expect(res.rows[0].got).toBe(true);
      await probe.query("select pg_advisory_unlock($1, $2)", [...KEYS]);
    } finally {
      probe.release();
    }
  });
});
