import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { loadModel } from "./helpers/load-model.js";

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
    `insert into raw.raw_events (source, event_id, event_type, payload)
     values ('crm', $1, 'company.updated', $2::jsonb)`,
    [
      eventId,
      JSON.stringify({
        occurred_at: occurredAt,
        data: { id: companyId, name, domain: `${companyId}.example.com` },
      }),
    ],
  );
}

// B2: the REAL warehouse/models/staging/stg_crm__companies.sql, loaded from disk — a
// hand-mirrored copy of this query drifted undetected (`like 'company.%'` vs the model's
// `= 'company.updated'`, under a comment claiming to be "the exact" query; external
// audit 2026-07-25, F2), which meant all three ordering invariants were proven against
// a query that was not in production. The model reads raw.raw_events directly (no refs),
// so it runs as-is against the ingest test DB — faster and more focused than a full dbt
// build for the property under test (late DELIVERY order must never beat event-time
// order). See docs/log/phase1.md for the note this test closes.
const LATEST_STATE_SQL = `
  select * from (${loadModel("models/staging/stg_crm__companies.sql")}) model
  where company_id = $1
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

  it("occurred_at is compared as a TIMESTAMP, not text: an offset timestamp that is EARLIER in real time must not win latest-state by sorting later as a string (L2-G2)", async () => {
    const companyId = "c-tz-test";

    // Verified mis-ordering pair (both are valid ISO-8601, so both pass the ingest gate):
    //   evt-4  "2026-07-22T09:00:00Z"      = 09:00 UTC  — the TRUE latest state
    //   evt-5  "2026-07-22T10:00:00+05:00" = 05:00 UTC  — 4 hours EARLIER in real time,
    // but as text "…T10:…" sorts AFTER "…T09:…", so a raw-string order-by crowns the
    // stale offset row "latest" forever.
    await insertRaw(pool, "evt-4", companyId, "True latest (09:00 UTC)", "2026-07-22T09:00:00Z");
    await insertRaw(pool, "evt-5", companyId, "Stale (05:00 UTC, +05:00 offset)", "2026-07-22T10:00:00+05:00");

    const res = await pool.query(LATEST_STATE_SQL, [companyId]);

    expect(res.rowCount).toBe(1);
    expect(res.rows[0].name).toBe("True latest (09:00 UTC)");
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

  it("company.merged events are excluded: no NULL-company_id row, and merge events never perturb latest-state", async () => {
    // The hazard the model's own comment warns about: merged events carry {from_id, to_id}
    // (no data.id/name), so including them would mint a NULL company_id row. The drifted
    // mirror (`like 'company.%'`) INCLUDED them — this case was untestable until the test
    // ran the real model text.
    const companyId = "c-merge-excl";
    await insertRaw(pool, "evt-20", companyId, "Real State", "2026-01-05T00:00:00.000Z");
    await pool.query(
      `insert into raw.raw_events (source, event_id, event_type, payload)
       values ('crm', 'evt-21', 'company.merged', $1::jsonb)`,
      [JSON.stringify({ occurred_at: "2026-01-06T00:00:00.000Z", data: { from_id: companyId, to_id: "c-other" } })],
    );

    const res = await pool.query(LATEST_STATE_SQL, [companyId]);
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].name).toBe("Real State"); // the (later) merge event didn't win latest-state

    const nullRows = await pool.query(
      `select * from (${loadModel("models/staging/stg_crm__companies.sql")}) m where company_id is null`,
    );
    expect(nullRows.rowCount).toBe(0);
  });
});
