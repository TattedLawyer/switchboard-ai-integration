import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";

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

async function insertRaw(
  pool: pg.Pool,
  eventId: string,
  companyId: string,
  name: string,
  occurredAt: string,
): Promise<void> {
  await pool.query(
    `insert into raw.raw_crm_events (event_id, event_type, payload)
     values ($1, 'company.updated', $2::jsonb)`,
    [
      eventId,
      JSON.stringify({
        occurred_at: occurredAt,
        data: { id: companyId, name, domain: `${companyId}.example.com` },
      }),
    ],
  );
}

// This is the exact latest-state-per-company query from
// warehouse/models/staging/stg_crm__companies.sql (DISTINCT ON, event-time order,
// evt-N ordinal tiebreak). Run directly against hand-inserted raw rows: proving the
// SQL-level order-by resolution is faster and more focused than a full dbt build for
// the property under test (late DELIVERY order must never beat event-time order), and
// keeps this test isolated to the ingest workspace's existing Postgres test harness
// rather than adding a dbt/warehouse dependency to CI here. See docs/log/phase1.md for
// the note this test closes ("out-of-order... composed chaos-with-shuffle... is a
// Phase 2 follow-up" — this proves the underlying order-by directly, independent of
// the full chaos pipeline).
const LATEST_STATE_SQL = `
  with company_events as (
    select event_id, payload, received_at
    from raw.raw_crm_events
    where event_type like 'company.%'
  ),
  latest as (
    select distinct on (payload -> 'data' ->> 'id')
      payload -> 'data' as company,
      received_at
    from company_events
    order by payload -> 'data' ->> 'id',
             (payload ->> 'occurred_at') desc,
             (substring(event_id from 5))::bigint desc
  )
  select
    company ->> 'id'     as company_id,
    company ->> 'name'   as name,
    company ->> 'domain' as domain,
    received_at          as last_event_at
  from latest
  where company ->> 'id' = $1
`;

describe("stg_crm__companies latest-state ordering", () => {
  it("a late-DELIVERED but occurred_at-STALE update never wins over a newer occurred_at row", async () => {
    const companyId = "c-order-test";

    // evt-1: the TRUE latest state (occurred_at is later), inserted (delivered) FIRST.
    await insertRaw(pool, "evt-1", companyId, "Newer State", "2026-01-10T00:00:00.000Z");

    // evt-2: a STALE update (occurred_at is earlier than evt-1's) that is DELIVERED
    // second (received_at is later, since it's inserted after — exactly what a
    // shuffle/out-of-order-delivery fault produces: the event was emitted earlier but
    // arrives late). If the model ordered by delivery/arrival time instead of event
    // time, this stale row would incorrectly become "latest".
    await insertRaw(pool, "evt-2", companyId, "Older State (delivered late)", "2026-01-01T00:00:00.000Z");

    const res = await pool.query(LATEST_STATE_SQL, [companyId]);

    expect(res.rowCount).toBe(1);
    // The row with the LATER occurred_at (evt-1, "Newer State") must win, even though
    // it was delivered/received before the stale evt-2 — proving occurred_at desc,
    // not received_at/arrival order, decides latest state.
    expect(res.rows[0].name).toBe("Newer State");
  });

  it("evt-N ordinal breaks ties when occurred_at is identical", async () => {
    const companyId = "c-tie-test";
    const sameTimestamp = "2026-01-05T00:00:00.000Z";

    await insertRaw(pool, "evt-3", companyId, "Lower ordinal", sameTimestamp);
    await insertRaw(pool, "evt-9", companyId, "Higher ordinal", sameTimestamp);

    const res = await pool.query(LATEST_STATE_SQL, [companyId]);

    expect(res.rowCount).toBe(1);
    expect(res.rows[0].name).toBe("Higher ordinal");
  });
});
