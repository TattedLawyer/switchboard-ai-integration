import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { ingestEvent } from "../src/ingest-event.js";
import type { SourceEvent } from "../src/server.js";

// B10 (debt-burn): ingest.outbox was NAMED for the transactional-outbox pattern and
// implemented half of it — rows written in the ingest transaction, then nothing. No
// message relay, no broker, no consumer exists anywhere (dbt reads raw.raw_events
// directly; durability comes from pg-boss), and the table grew one row per event
// forever with processed_at never set. The pattern's authority (microservices.io)
// defines the outbox as the in-transaction insert PLUS a separate publishing process;
// with no downstream consumer, a relay would publish to nobody. Honest fix: rename to
// what it is — ingest.ingest_journal, an in-transaction ingest audit row and the
// demo's equality counter — and bound its growth (30-day TTL; the reasoning for TTL
// over a size cap is in migration 011).

let pool: pg.Pool;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const r = await freshTestDb();
  pool = r.pool;
  cleanup = r.cleanup;
});
afterAll(async () => {
  await cleanup();
});

const event = (id: string): SourceEvent => ({
  event_id: id,
  event_type: "company.updated",
  occurred_at: new Date().toISOString(),
  data: { id: "DEMO-C-0001" },
});

describe("B10: ingest.ingest_journal — the honest name, still the equality counter", () => {
  it("the table named for a pattern the system doesn't implement is gone; the journal exists without the relay's processed_at", async () => {
    const outbox = await pool.query("select to_regclass('ingest.outbox') as t");
    expect(outbox.rows[0].t).toBeNull();
    const journal = await pool.query("select to_regclass('ingest.ingest_journal') as t");
    expect(journal.rows[0].t).toBe("ingest.ingest_journal");
    // processed_at was the relay's promise — a journal records, it does not dispatch.
    const cols = await pool.query(
      `select column_name from information_schema.columns
        where table_schema = 'ingest' and table_name = 'ingest_journal'`,
    );
    const names = cols.rows.map((r: { column_name: string }) => r.column_name);
    expect(names).not.toContain("processed_at");
  });

  it("equality basis unchanged: one journal row per accepted event, none for a duplicate", async () => {
    expect(await ingestEvent(pool, "crm", event("evt-j1"))).toBe("inserted");
    expect(await ingestEvent(pool, "crm", event("evt-j1"))).toBe("duplicate");
    const rows = await pool.query(
      "select count(*)::int as n from ingest.ingest_journal where event_id = 'evt-j1'",
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it("TTL: a journal row past the 30-day window is pruned by the next accepted event's insert", async () => {
    // Backdate a row past the TTL boundary (direct SQL — the door can't write the past).
    await pool.query(
      `insert into ingest.ingest_journal (tenant_id, source, event_id, created_at)
       values ('00000000-0000-0000-0000-000000000000', 'crm', 'evt-ancient', now() - interval '31 days')`,
    );
    expect(await ingestEvent(pool, "crm", event("evt-j2"))).toBe("inserted");
    const ancient = await pool.query(
      "select count(*)::int as n from ingest.ingest_journal where event_id = 'evt-ancient'",
    );
    expect(ancient.rows[0].n).toBe(0);
    // …and rows inside the window survive the same prune.
    const recent = await pool.query(
      "select count(*)::int as n from ingest.ingest_journal where event_id in ('evt-j1', 'evt-j2')",
    );
    expect(recent.rows[0].n).toBe(2);
  });
});
