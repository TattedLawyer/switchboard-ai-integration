import pg from "pg";
import { runMigrations } from "../../src/migrate.js";

export interface TestDbResult {
  pool: pg.Pool;
  /** Connection string of the ephemeral database — for tests that spawn a CLI as a
   *  child process and must point ITS DATABASE_URL at the same throwaway db. */
  url: string;
  cleanup: () => Promise<void>;
}

/** Termination-class error codes a test-suite pool may legitimately see during
 *  teardown: 57P01 admin termination (what `drop database ... with (force)` does to
 *  surviving backends), 57P02 crash shutdown, 08006 connection failure. Task F
 *  (register, twice-bitten): one of these reaching a pool with no 'error' listener
 *  failed an entire CI run with ZERO failing tests. */
const TEARDOWN_ERROR_CODES = new Set(["57P01", "57P02", "08006"]);

const swallowTeardownErrors = (pool: pg.Pool, label: string): void => {
  pool.on("error", (err) => {
    const code = (err as { code?: string }).code;
    if (code !== undefined && TEARDOWN_ERROR_CODES.has(code)) return; // expected during teardown
    // Anything else is a real anomaly — surface it WITHOUT crashing the run (an
    // unhandled 'error' event is a process kill, the exact flake this helper fixes).
    console.warn(`testdb ${label} pool error (non-teardown):`, err);
  });
};

export async function freshTestDb(): Promise<TestDbResult> {
  const originalUrl = process.env.DATABASE_URL;
  if (!originalUrl) throw new Error("DATABASE_URL is required");

  // Generate a unique database name using timestamp and random suffix
  const dbName = `switchboard_test_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  // Replace the database name with 'postgres' to connect to admin DB
  const adminUrl = originalUrl.replace(/\/[^/?]*(\?|$)/, "/postgres$1");
  const adminPool = new pg.Pool({ connectionString: adminUrl });
  swallowTeardownErrors(adminPool, "admin");

  try {
    // Create new test database
    await adminPool.query(`create database "${dbName}"`);
  } finally {
    await adminPool.end();
  }

  // Connect to the new test database and run migrations
  const testUrl = originalUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`);
  const testPool = new pg.Pool({ connectionString: testUrl });
  swallowTeardownErrors(testPool, "test");

  await runMigrations(testPool);

  // Cleanup: IDEMPOTENT and termination-proof (Task F, register escalation).
  //   · re-entry guard — afterEach + suite-teardown overlap must never become
  //     "Called end on pool more than once";
  //   · pool.end() failures are swallowed — a pool whose clients were already killed
  //     by an administrator command is exactly the state cleanup exists to clear;
  //   · own backends are terminated BEFORE the drop, so client deaths happen while
  //     this function controls sequencing rather than as force-drop collateral on
  //     whatever pool is still listening.
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;

    try {
      await testPool.end();
    } catch {
      // Already ended, or its clients died to a termination — either way, torn down.
    }

    const cleanupAdminUrl = originalUrl.replace(/\/[^/?]*(\?|$)/, "/postgres$1");
    const cleanupPool = new pg.Pool({ connectionString: cleanupAdminUrl });
    swallowTeardownErrors(cleanupPool, "cleanup-admin");
    try {
      await cleanupPool.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
          where datname = $1 and pid <> pg_backend_pid()`,
        [dbName],
      );
      await cleanupPool.query(`drop database if exists "${dbName}" with (force)`);
    } finally {
      await cleanupPool.end();
    }
  };

  return { pool: testPool, url: testUrl, cleanup };
}
