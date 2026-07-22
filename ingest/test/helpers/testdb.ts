import pg from "pg";
import { runMigrations } from "../../src/migrate.js";

export interface TestDbResult {
  pool: pg.Pool;
  cleanup: () => Promise<void>;
}

export async function freshTestDb(): Promise<TestDbResult> {
  const originalUrl = process.env.DATABASE_URL;
  if (!originalUrl) throw new Error("DATABASE_URL is required");

  // Generate a unique database name using timestamp and random suffix
  const dbName = `switchboard_test_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  // Replace the database name with 'postgres' to connect to admin DB
  const adminUrl = originalUrl.replace(/\/[^/?]*(\?|$)/, "/postgres$1");
  const adminPool = new pg.Pool({ connectionString: adminUrl });

  try {
    // Create new test database
    await adminPool.query(`create database "${dbName}"`);
  } finally {
    await adminPool.end();
  }

  // Connect to the new test database and run migrations
  const testUrl = originalUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`);
  const testPool = new pg.Pool({ connectionString: testUrl });

  await runMigrations(testPool);

  // Cleanup function: end pool, then connect as admin and drop the ephemeral database
  const cleanup = async (): Promise<void> => {
    // End the test pool first
    await testPool.end();

    // Connect as admin and drop the database with force
    const cleanupAdminUrl = originalUrl.replace(/\/[^/?]*(\?|$)/, "/postgres$1");
    const cleanupPool = new pg.Pool({ connectionString: cleanupAdminUrl });
    try {
      await cleanupPool.query(`drop database if exists "${dbName}" with (force)`);
    } finally {
      await cleanupPool.end();
    }
  };

  return { pool: testPool, cleanup };
}
