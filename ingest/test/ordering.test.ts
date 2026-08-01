import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { loadModel } from "./helpers/load-model.js";
import { insertHubObjectState } from "./helpers/hub-staging.js";

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

// F-1c: stg_crm__companies is hubcrm-snapshot-sourced, so each "state" is a thin event
// in raw plus its hydrated snapshot (the shared helper writes both, exactly as the pump
// does). The ordering CLAIMS are unchanged from the 2a era — event time beats delivery
// time, timestamps compare as timestamptz, received_at breaks true ties — because the
// successor ordering rides the TRIGGERING event's clocks, never fetch time alone.
let objectSeq = 700;
const objectIdOf = new Map<string, number>();
async function insertState(
  eventId: string,
  companyId: string,
  name: string,
  occurredAt: string,
  receivedAt?: string,
): Promise<void> {
  let objectId = objectIdOf.get(companyId);
  if (objectId === undefined) {
    objectId = ++objectSeq;
    objectIdOf.set(companyId, objectId);
  }
  await insertHubObjectState(pool, {
    objectType: "company",
    objectId,
    eventId,
    eventType: "company.propertyChange",
    occurredAt,
    receivedAt,
    properties: { name, domain: `${companyId}.example.com`, hs_manifest_id: companyId },
  });
}

// B2: the REAL warehouse/models/staging/stg_crm__companies.sql, loaded from disk — a
// hand-mirrored copy of this query drifted undetected once (external audit 2026-07-25,
// F2); the model reads raw.raw_events + ingest.hydrated_snapshots directly (no refs),
// so it runs as-is against the ingest test DB.
const LATEST_STATE_SQL = `
  select * from (${loadModel("models/staging/stg_crm__companies.sql")}) model
  where company_id = $1
`;

describe("stg_crm__companies latest-state ordering", () => {
  it("a late-DELIVERED but occurred_at-STALE update never wins over a newer occurred_at row", async () => {
    const companyId = "c-order-test";

    // evt-1: the TRUE latest state (occurred_at is later), delivered FIRST.
    await insertState("9101", companyId, "Newer State", "2026-01-10T00:00:00.000Z");

    // evt-2: a STALE state (occurred_at earlier) DELIVERED second — exactly what an
    // out-of-order webhook delivery produces. If the model ordered by arrival (or by
    // fetch time), this stale row would incorrectly become "latest".
    await insertState("9102", companyId, "Older State (delivered late)", "2026-01-01T00:00:00.000Z", new Date().toISOString());

    const res = await pool.query(LATEST_STATE_SQL, [companyId]);

    expect(res.rowCount).toBe(1);
    expect(res.rows[0].name).toBe("Newer State");
  });

  it("occurred_at is compared as a TIMESTAMP, not text: an offset timestamp that is EARLIER in real time must not win latest-state by sorting later as a string (L2-G2)", async () => {
    const companyId = "c-tz-test";

    // Verified mis-ordering pair (both valid ISO-8601):
    //   "2026-07-22T09:00:00Z"      = 09:00 UTC — the TRUE latest state
    //   "2026-07-22T10:00:00+05:00" = 05:00 UTC — 4h EARLIER in real time, but sorts
    // AFTER as a string, so a raw-string order-by crowns the stale row forever.
    await insertState("9104", companyId, "True latest (09:00 UTC)", "2026-07-22T09:00:00Z");
    await insertState("9105", companyId, "Stale (05:00 UTC, +05:00 offset)", "2026-07-22T10:00:00+05:00");

    const res = await pool.query(LATEST_STATE_SQL, [companyId]);

    expect(res.rowCount).toBe(1);
    expect(res.rows[0].name).toBe("True latest (09:00 UTC)");
  });

  it("received_at breaks ties when occurred_at is identical (successor tiebreak — the later arrival wins)", async () => {
    const companyId = "c-tie-test";
    const sameTimestamp = "2026-01-05T00:00:00.000Z";

    await insertState("9107", companyId, "First arrival", sameTimestamp, "2026-01-05T00:01:00.000Z");
    await insertState("9108", companyId, "Later arrival", sameTimestamp, "2026-01-05T00:02:00.000Z");

    const res = await pool.query(LATEST_STATE_SQL, [companyId]);

    expect(res.rowCount).toBe(1);
    expect(res.rows[0].name).toBe("Later arrival");
  });

  it("a tombstoned object stages nothing, and no NULL-company_id row ever appears (the 2a merge-event exclusion's successor claim)", async () => {
    const companyId = "c-tomb-excl";
    await insertState("9120", companyId, "Real State", "2026-01-05T00:00:00.000Z");
    // The object's newest hydration answered 404 (deleted / consumed by a merge):
    await insertHubObjectState(pool, {
      objectType: "company",
      objectId: objectIdOf.get(companyId)!,
      eventId: "9121",
      eventType: "company.propertyChange",
      occurredAt: "2026-01-06T00:00:00.000Z",
      tombstone: true,
    });

    const res = await pool.query(LATEST_STATE_SQL, [companyId]);
    expect(res.rowCount).toBe(0); // the object no longer exists at the source

    const nullRows = await pool.query(
      `select * from (${loadModel("models/staging/stg_crm__companies.sql")}) m where company_id is null`,
    );
    expect(nullRows.rowCount).toBe(0);
  });
});
