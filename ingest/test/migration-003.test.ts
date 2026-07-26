import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const sql = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");

describe("migration 003: raw_crm_events → raw_events(source)", () => {
  it("copies every legacy row with source='crm', preserves payloads, then drops the old table; idempotent on re-run", async () => {
    const originalUrl = process.env.DATABASE_URL!;
    const dbName = `switchboard_test_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const adminUrl = originalUrl.replace(/\/[^/?]*(\?|$)/, "/postgres$1");
    const admin = new pg.Pool({ connectionString: adminUrl });
    await admin.query(`create database "${dbName}"`);
    await admin.end();
    const pool = new pg.Pool({ connectionString: originalUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) });
    try {
      // Phase 1 state: run only 001 + 002, then insert a legacy row.
      await pool.query(sql("001_raw_events.sql"));
      await pool.query(sql("002_reliability.sql"));
      await pool.query(
        `insert into raw.raw_crm_events (event_id, event_type, payload)
         values ('evt-1', 'company.updated', '{"event_id":"evt-1","data":{"id":"DEMO-C-0001"}}'::jsonb)`,
      );
      // The migration under test.
      await pool.query(sql("003_multi_source.sql"));
      const migrated = await pool.query(
        "select source, event_id, payload from raw.raw_events order by id",
      );
      expect(migrated.rows).toHaveLength(1);
      expect(migrated.rows[0].source).toBe("crm");
      expect(migrated.rows[0].event_id).toBe("evt-1");
      expect(migrated.rows[0].payload.data.id).toBe("DEMO-C-0001");
      const legacy = await pool.query("select to_regclass('raw.raw_crm_events') as t");
      expect(legacy.rows[0].t).toBeNull();
      // Idempotence: the whole 001→003 sequence again (exactly what runMigrations does).
      await pool.query(sql("001_raw_events.sql"));
      await pool.query(sql("002_reliability.sql"));
      await pool.query(sql("003_multi_source.sql"));
      const after = await pool.query("select count(*)::int as n from raw.raw_events");
      expect(after.rows[0].n).toBe(1);
      // Unique index is now (source, event_id): same event_id under a DIFFERENT source inserts.
      await pool.query(
        `insert into raw.raw_events (source, event_id, event_type, payload)
         values ('billing', 'evt-1', 'invoice.created', '{}'::jsonb)`,
      );
      const both = await pool.query("select count(*)::int as n from raw.raw_events where event_id='evt-1'");
      expect(both.rows[0].n).toBe(2);
    } finally {
      await pool.end();
      const admin2 = new pg.Pool({ connectionString: adminUrl });
      await admin2.query(`drop database if exists "${dbName}" with (force)`);
      await admin2.end();
    }
  });
});
