import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { ingestEvent } from "../src/ingest-event.js";
import type { SourceEvent } from "../src/server.js";

// TENANCY — the highest-severity undisclosed defect the external audit found, and the only
// one on the production-gap list that DESTROYS DATA rather than merely being absent.
//
// `raw.raw_events` is unique on (source, event_id) and ingestEvent does `on conflict do
// nothing`, returning "duplicate". That is exactly right for one tenant: it is the
// exactly-once guarantee the whole reliability spine rests on. With two tenants it is a
// silent data-loss bug, because two different businesses both legitimately have an event
// numbered `evt-1` from their own CRM. The second one to arrive is swallowed and reported
// as a successful de-duplication. Nothing errors, nothing quarantines, nothing alerts.
//
// It is worse than a dropped event: downstream, identity resolution has no tenant partition
// either, so two clients' "Acme Corp / acme.com" resolve to ONE canonical entity and
// customer_360 sums both businesses' revenue into a single row.
//
// These tests define tenancy as a database-enforced fact, not an application convention:
// the uniqueness key must be (tenant_id, source, event_id), and row-level security must be
// FORCEd so that even the table owner cannot read across tenants. Postgres's documented
// behaviour is that a table owner BYPASSES its own RLS policies unless FORCE ROW LEVEL
// SECURITY is set — the most common way RLS is silently inert in production — so "we enabled
// RLS" is not a claim worth making without a test that proves it binds the role we use.

let pool: pg.Pool;
let cleanup: () => Promise<void>;

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

function evt(id: string, name: string): SourceEvent {
  return {
    event_id: id,
    event_type: "company.updated",
    occurred_at: new Date().toISOString(),
    data: { id: "C-1", name },
  } as unknown as SourceEvent;
}

beforeEach(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
});
afterEach(async () => {
  await cleanup();
});

describe("tenant isolation — two businesses must not collide", () => {
  it("does NOT swallow a second tenant's event that happens to share an event_id", async () => {
    // Both tenants legitimately emit evt-1 from their own CRM. Neither is a duplicate.
    const a = await ingestEvent(pool, "crm", evt("evt-1", "Acme Corp"), { tenantId: TENANT_A });
    const b = await ingestEvent(pool, "crm", evt("evt-1", "Beta Industries"), { tenantId: TENANT_B });

    expect(a).toBe("inserted");
    // Today this returns "duplicate" and tenant B's event is gone forever.
    expect(b).toBe("inserted");

    const rows = await pool.query("select tenant_id, event_id from raw.raw_events order by tenant_id");
    expect(rows.rowCount).toBe(2);
  });

  it("still de-duplicates WITHIN a tenant — tenancy must not weaken exactly-once", async () => {
    const first = await ingestEvent(pool, "crm", evt("evt-7", "Acme Corp"), { tenantId: TENANT_A });
    const again = await ingestEvent(pool, "crm", evt("evt-7", "Acme Corp"), { tenantId: TENANT_A });

    expect(first).toBe("inserted");
    expect(again).toBe("duplicate");

    const rows = await pool.query("select count(*)::int as n from raw.raw_events");
    expect(rows.rows[0].n).toBe(1);
  });

  it("writes exactly one journal row per accepted event, per tenant — the demo's equality counter must not merge tenants either", async () => {
    await ingestEvent(pool, "crm", evt("evt-1", "Acme Corp"), { tenantId: TENANT_A });
    await ingestEvent(pool, "crm", evt("evt-1", "Beta Industries"), { tenantId: TENANT_B });

    const out = await pool.query("select tenant_id from ingest.ingest_journal order by tenant_id");
    expect(out.rowCount).toBe(2);
    expect(out.rows.map((r) => r.tenant_id)).toEqual([TENANT_A, TENANT_B]);
  });

  it("requires a tenant — an event with no tenant must be REFUSED, never defaulted", async () => {
    // A default tenant would silently re-create the collision this whole migration removes,
    // and would do it in the one code path nobody looks at again.
    await expect(
      ingestEvent(pool, "crm", evt("evt-9", "Nobody"), { tenantId: "" }),
    ).rejects.toThrow(/tenant/i);
  });
});

describe("tenant isolation is enforced by the DATABASE, not by application convention", () => {
  it("FORCEs row level security on raw.raw_events — without FORCE the table owner bypasses every policy, which is the documented way RLS ends up silently inert", async () => {
    const res = await pool.query(`
      select relrowsecurity, relforcerowsecurity
      from pg_class where oid = 'raw.raw_events'::regclass
    `);
    expect(res.rows[0].relrowsecurity).toBe(true);
    expect(res.rows[0].relforcerowsecurity).toBe(true);
  });

  it("hides other tenants' rows from the APPLICATION role once a tenant context is set — proven through switchboard_app, because PostgreSQL documents that superusers ALWAYS bypass RLS and this project's default role is one", async () => {
    await ingestEvent(pool, "crm", evt("evt-1", "Acme Corp"), { tenantId: TENANT_A });
    await ingestEvent(pool, "crm", evt("evt-1", "Beta Industries"), { tenantId: TENANT_B });

    // Precondition, so this test cannot pass vacuously: with no tenant context set there must
    // be BOTH rows to hide. Without this, the collision bug alone leaves a single row and the
    // filtered assertion below would "pass" while proving nothing.
    const all = await pool.query("select count(*)::int as n from raw.raw_events");
    expect(all.rows[0].n).toBe(2);

    // Connect as the non-superuser application role. Using the default superuser role here
    // would make this test pass-by-bypass — it would report isolation while RLS was inert.
    const appPool = new (await import("pg")).default.Pool({
      connectionString: (pool as unknown as { options: { connectionString?: string } }).options
        ?.connectionString?.replace("switchboard:switchboard@", "switchboard_app:switchboard_app@"),
    });
    try {
      const client = await appPool.connect();
      try {
        await client.query("select set_config('switchboard.tenant_id', $1, false)", [TENANT_A]);
        const visible = await client.query("select event_id, payload from raw.raw_events");
        expect(visible.rowCount).toBe(1);
        expect(visible.rows[0].payload.data.name).toBe("Acme Corp");
      } finally {
        client.release();
      }
    } finally {
      await appPool.end();
    }
  });

  it("indexes tenant_id — an RLS predicate on an unindexed column turns every read into a scan", async () => {
    const res = await pool.query(`
      select indexdef from pg_indexes
      where schemaname = 'raw' and tablename = 'raw_events'
    `);
    // FIX ROUND (PRE-3 review, Important 1 — the same defect class, second member, found
    // by sweeping for it). These predicates ran against the WHOLE `indexdef`, which begins
    // `CREATE [UNIQUE] INDEX <name> ON <table> USING btree (...)`. The names on this table
    // are `ix_raw_events_tenant_id` and `uq_raw_events_tenant_source_event_id`, so
    // `/tenant_id/` was satisfied by the first index's NAME and `/event_id/` by the
    // second's — the assertion could not distinguish "indexed on tenant_id" from "named
    // after tenant_id", which is exactly the "unindexed column, every read a scan"
    // condition this test exists to forbid.
    //
    // Exposure was narrower here than in migration-013's case (verified, not assumed): the
    // second predicate needs `tenant_id` from a UNIQUE definition, and the unique index's
    // name spells `tenant_source_event_id`, which does NOT contain `tenant_id` — so a
    // mutation removing tenant_id from every column list still redded the test overall.
    // Fixed anyway: a predicate that cannot tell a name from a column is one column-rename
    // away from being the silent kind, and this is the sweep's whole point.
    //
    // Everything after `USING <method> (` is the column list and nothing else: no index
    // name, no table name. Keyword assertions (`UNIQUE`) stay on the full definition,
    // where they belong and where no name can supply them.
    const defs: string[] = res.rows.map((r) => r.indexdef);
    const columnsOf = (d: string): string => d.slice(d.indexOf("USING "));
    // The stripper is load-bearing, so it is checked rather than trusted: if it ever stops
    // removing the name, every predicate below silently becomes name-satisfiable again.
    for (const d of defs) {
      expect(columnsOf(d), `could not isolate the column list from: ${d}`).toMatch(/^USING \w+ \(/);
      expect(columnsOf(d), `the index NAME is still inside the string being asserted on: ${d}`)
        .not.toMatch(/raw_events/);
    }
    expect(defs.some((d) => /tenant_id/.test(columnsOf(d)))).toBe(true);
    // The uniqueness key itself must be tenant-scoped, not global.
    expect(
      defs.some(
        (d) => /unique/i.test(d) && /tenant_id/.test(columnsOf(d)) && /event_id/.test(columnsOf(d)),
      ),
    ).toBe(true);
  });
});
