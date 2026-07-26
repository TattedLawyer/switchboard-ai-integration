import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const sql = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");
const ALL = ["001_raw_events.sql", "002_reliability.sql", "003_multi_source.sql", "004_nul_safe_quarantine.sql"];

describe("migration 004: NUL-safe quarantine (nullable payload + raw_body text)", () => {
  it("upgrades a pre-004 quarantine table, accepts raw_body-only rows, keeps old rows; idempotent on re-run", async () => {
    const originalUrl = process.env.DATABASE_URL!;
    const dbName = `switchboard_test_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const adminUrl = originalUrl.replace(/\/[^/?]*(\?|$)/, "/postgres$1");
    const admin = new pg.Pool({ connectionString: adminUrl });
    await admin.query(`create database "${dbName}"`);
    await admin.end();
    const pool = new pg.Pool({ connectionString: originalUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) });
    try {
      // Pre-004 state: 001–003, plus an existing (jsonb-payload) quarantine row.
      for (const f of ALL.slice(0, 3)) await pool.query(sql(f));
      await pool.query(
        `insert into ingest.quarantine (source, payload, reason)
         values ('crm', '{"bogus":true}'::jsonb, 'schema validation failed')`,
      );
      // The migration under test.
      await pool.query(sql("004_nul_safe_quarantine.sql"));
      // A NUL-bearing payload is now storable as raw text with no jsonb payload. (The \\u0000
      // here is the six-character escape sequence as it appears in the JSON wire text — a text
      // column holds it fine; an ACTUAL NUL byte is what neither text nor jsonb can hold.)
      await pool.query(
        `insert into ingest.quarantine (source, raw_body, reason)
         values ('crm', '{"event_id":"evt-nul","data":{"name":"a\\u0000b"}}', 'payload contains \\u0000 (NUL)')`,
      );
      const rows = await pool.query(
        "select payload, raw_body from ingest.quarantine order by id",
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0].payload).toEqual({ bogus: true }); // pre-004 row untouched
      expect(rows.rows[0].raw_body).toBeNull();
      expect(rows.rows[1].payload).toBeNull();
      expect(rows.rows[1].raw_body).toContain("\\u0000");
      // Idempotence: the whole 001→004 sequence again (exactly what runMigrations does).
      for (const f of ALL) await pool.query(sql(f));
      const after = await pool.query("select count(*)::int as n from ingest.quarantine");
      expect(after.rows[0].n).toBe(2);
    } finally {
      await pool.end();
      const admin2 = new pg.Pool({ connectionString: adminUrl });
      await admin2.query(`drop database if exists "${dbName}" with (force)`);
      await admin2.end();
    }
  });
});
