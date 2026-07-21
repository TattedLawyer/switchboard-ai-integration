import pg from "pg";
import { runMigrations } from "../../src/migrate.js";

export async function freshTestDb(): Promise<pg.Pool> {
  const originalUrl = process.env.DATABASE_URL;
  if (!originalUrl) throw new Error("DATABASE_URL is required");

  // Replace the database name with 'postgres' to connect to admin DB
  const adminUrl = originalUrl.replace(/\/[^/?]*(\?|$)/, "/postgres$1");
  const adminPool = new pg.Pool({ connectionString: adminUrl });

  try {
    // Drop test database if it exists (force to handle active connections)
    await adminPool.query("drop database if exists switchboard_test with (force)");
    // Create new test database
    await adminPool.query("create database switchboard_test");
  } finally {
    await adminPool.end();
  }

  // Connect to the new test database and run migrations
  const testUrl = originalUrl.replace(/\/[^/?]*(\?|$)/, "/switchboard_test$1");
  const testPool = new pg.Pool({ connectionString: testUrl });

  await runMigrations(testPool);

  return testPool;
}
