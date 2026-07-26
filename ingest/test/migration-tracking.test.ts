import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { runMigrations, appliedMigrations } from "../src/migrate.js";

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
