import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { loadModel } from "./helpers/load-model.js";
import { insertHubObjectState } from "./helpers/hub-staging.js";
import { createIso4217Fixture, createNumericBoundsFixture, ISO_4217_REF } from "./helpers/numeric-bounds.js";

// The billing staging models join ref('numeric_bounds') since Wave 5 (Task G) — the
// fixture materializes the COMMITTED seed; extra refMap entries are inert for models
// without the ref.
const BOUNDS_REF = { numeric_bounds: "numeric_bounds", ...ISO_4217_REF };

// L2 (blast-radius containment): these tests insert malformed numerics DIRECTLY into
// raw.raw_events, bypassing the ingest door's numeric contract (L1) ON PURPOSE — the
// scenario is rows that never passed a door: pre-contract legacy rows, direct inserts,
// historical backfill. A malformed amount/score already sitting in raw must degrade to
// a NULL in staging output, not throw `invalid input syntax` and kill the whole build.
// B2: the REAL model text is loaded from disk via loadModel — no hand-mirrored SQL.

// Syntactically numeric but out of range for bigint (max 9223372036854775807) and int.
const OUT_OF_RANGE = "99999999999999999999";

let pool: pg.Pool;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ pool, cleanup } = await freshTestDb());
  await createNumericBoundsFixture(pool);
  await createIso4217Fixture(pool);
});

afterEach(async () => {
  await cleanup();
});

interface ModelSpec {
  title: string;
  modelPath: string;
  source: string;
  eventType: string;
  /** column name of the guarded numeric in the model's output */
  valueColumn: string;
  /** column name of the entity id in the model's output */
  idColumn: string;
  /** well-formed value as it appears in the payload, and as pg returns the column */
  goodValue: string;
  goodExpected: string | number; // pg returns bigint as string, int4 as number
  /** payload `data` object for one event */
  makeData: (entityId: string, value: string) => Record<string, unknown>;
}

const SPECS: ModelSpec[] = [
  // F-1c: the billing arms are stripefeed-sourced (envelope data.object shapes) and the
  // deals arm is hubcrm-snapshot-sourced — each spec seeds through its OWN source shape.
  {
    title: "stg_billing__invoices",
    modelPath: "models/staging/stg_billing__invoices.sql",
    source: "stripefeed",
    eventType: "invoice.finalized",
    valueColumn: "amount_cents",
    idColumn: "invoice_id",
    goodValue: "1000",
    goodExpected: "1000",
    makeData: (id, value) => ({ id, object: "invoice", customer_id: "cust-1", amount_cents: value }),
  },
  {
    title: "stg_billing__payments",
    modelPath: "models/staging/stg_billing__payments.sql",
    source: "stripefeed",
    eventType: "charge.succeeded",
    valueColumn: "amount_cents",
    idColumn: "payment_id",
    goodValue: "2500",
    goodExpected: "2500",
    makeData: (id, value) => ({
      id,
      object: "charge",
      invoice_id: "inv-1",
      customer_id: "cust-1",
      amount_cents: value,
    }),
  },
  {
    title: "stg_support__csat",
    modelPath: "models/staging/stg_support__csat.sql",
    source: "support",
    eventType: "csat.recorded",
    valueColumn: "score",
    idColumn: "csat_id",
    goodValue: "4",
    goodExpected: 4,
    // distinct on ticket_id — derive a unique ticket per entity so all rows survive
    makeData: (id, value) => ({ id, ticket_id: `ticket-${id}`, score: value }),
  },
];

async function insertRawEvent(
  spec: ModelSpec,
  eventId: string,
  entityId: string,
  value: string,
): Promise<void> {
  await pool.query(
    `insert into raw.raw_events (source, event_id, event_type, payload)
     values ($1, $2, $3, $4::jsonb)`,
    [
      spec.source,
      eventId,
      spec.eventType,
      JSON.stringify({
        occurred_at: "2026-01-05T00:00:00.000Z",
        data: spec.makeData(entityId, value),
      }),
    ],
  );
}

for (const spec of SPECS) {
  describe(`${spec.title} — L2 safe cast`, () => {
    it("a malformed numeric already in raw yields NULL (query does not throw); well-formed rows keep their value; out-of-range degrades to NULL too", async () => {
      await insertRawEvent(spec, "evt-1", "e-good", spec.goodValue);
      await insertRawEvent(spec, "evt-2", "e-bad", "abc");
      await insertRawEvent(spec, "evt-3", "e-huge", OUT_OF_RANGE);

      // With the bare `::bigint` / `::int` cast this THROWS `invalid input syntax`
      // and the entire model (in production: the entire dbt build) dies.
      const res = await pool.query(
        `select * from (${loadModel(spec.modelPath, BOUNDS_REF)}) m order by ${spec.idColumn}`,
      );

      expect(res.rowCount).toBe(3);
      const byId = Object.fromEntries(res.rows.map((r) => [r[spec.idColumn], r]));

      // The one bad row is contained to one NULL...
      expect(byId["e-bad"][spec.valueColumn]).toBeNull();
      // ...including syntactically-numeric-but-out-of-range garbage...
      expect(byId["e-huge"][spec.valueColumn]).toBeNull();
      // ...while the well-formed neighbor is untouched.
      expect(byId["e-good"][spec.valueColumn]).toBe(spec.goodExpected);
    });
  });
}

// Security review M2: currency is payload-controlled text that flows to the mart, the MCP
// read tool, and the report's LLM prompt. Staging constrains it to a three-letter uppercase
// code at the source; anything else becomes NULL (the L5.1 "unknown" leniency path) rather
// than riding a free-text channel downstream.
describe("stg_crm__deals — L2 safe cast (hubcrm snapshot arm)", () => {
  it("a malformed or out-of-range amount in a snapshot yields NULL; the well-formed neighbor keeps its value", async () => {
    const mk = (objectId: number, eventId: string, dealId: string, amount: string) =>
      insertHubObjectState(pool, {
        objectType: "deal", objectId, eventId,
        occurredAt: "2026-01-05T00:00:00.000Z",
        properties: { name: `DEMO Deal ${dealId}`, amount_cents: amount, currency: "USD", status: "open", company_manifest_id: "co-1", hs_manifest_id: dealId },
      });
    await mk(601, "7601", "e-good", "75000");
    await mk(602, "7602", "e-bad", "abc");
    await mk(603, "7603", "e-huge", OUT_OF_RANGE);

    const res = await pool.query(
      `select * from (${loadModel("models/staging/stg_crm__deals.sql", ISO_4217_REF)}) m order by deal_id`,
    );
    expect(res.rowCount).toBe(3);
    const byId = Object.fromEntries(res.rows.map((r) => [r.deal_id, r]));
    expect(byId["e-bad"].amount_cents).toBeNull();
    expect(byId["e-huge"].amount_cents).toBeNull();
    expect(byId["e-good"].amount_cents).toBe("75000");
  });

  it("currency constraint (security M2): 'USD' passes; lowercase and injection-shaped values are NULLed", async () => {
    const mk = (objectId: number, eventId: string, dealId: string, currency: string | null) =>
      insertHubObjectState(pool, {
        objectType: "deal", objectId, eventId,
        occurredAt: "2026-01-05T00:00:00.000Z",
        properties: { name: `DEMO Deal ${dealId}`, amount_cents: "1000", currency, status: "open", company_manifest_id: "co-1", hs_manifest_id: dealId },
      });
    await mk(611, "7611", "e-upper", "USD");
    await mk(612, "7612", "e-lower", "usd");
    await mk(613, "7613", "e-inject", "EUR;drop table x");
    await mk(614, "7614", "e-cleared", null); // the script's currency CLEAR — null property

    const res = await pool.query(
      `select * from (${loadModel("models/staging/stg_crm__deals.sql", ISO_4217_REF)}) m order by deal_id`,
    );
    expect(res.rowCount).toBe(4);
    const byId = Object.fromEntries(res.rows.map((r) => [r.deal_id, r]));
    expect(byId["e-upper"].currency).toBe("USD");
    expect(byId["e-lower"].currency).toBeNull();
    expect(byId["e-inject"].currency).toBeNull();
    expect(byId["e-cleared"].currency).toBeNull();
  });
});

describe("staging currency constraint (security M2)", () => {
  const CURRENCY_SPECS = [
    // F-1c: stripefeed-sourced; the deals (hubcrm snapshot) constraint is pinned in its
    // own describe above.
    {
      title: "stg_billing__invoices",
      modelPath: "models/staging/stg_billing__invoices.sql",
      source: "stripefeed",
      eventType: "invoice.finalized",
      idColumn: "invoice_id",
      makeData: (id: string, currency: unknown) => ({
        id, object: "invoice", customer_id: "cust-1", amount_cents: 1000,
        ...(currency === undefined ? {} : { currency }),
      }),
    },
  ] as const;

  for (const spec of CURRENCY_SPECS) {
    it(`${spec.title}: 'USD' passes; lowercase 'usd' and injection-shaped 'EUR;drop table x' are NULLed`, async () => {
      // Distinct entities per row — the latest-state tiebreak (occurred_at desc,
      // received_at desc, event_id desc; Task C successor) never fires here.
      const rows: Array<[string, string, unknown]> = [
        ["evt-9001", "e-upper", "USD"],
        ["evt-9002", "e-lower", "usd"],
        ["evt-9003", "e-inject", "EUR;drop table x"],
        ["evt-9004", "e-absent", undefined],
      ];
      for (const [eventId, entityId, currency] of rows) {
        await pool.query(
          `insert into raw.raw_events (source, event_id, event_type, payload)
           values ($1, $2, $3, $4::jsonb)`,
          [
            spec.source,
            eventId,
            spec.eventType,
            JSON.stringify({
              occurred_at: "2026-01-05T00:00:00.000Z",
              data: spec.makeData(entityId, currency),
            }),
          ],
        );
      }

      const res = await pool.query(
        `select * from (${loadModel(spec.modelPath, BOUNDS_REF)}) m order by ${spec.idColumn}`,
      );
      expect(res.rowCount).toBe(4);
      const byId = Object.fromEntries(res.rows.map((r) => [r[spec.idColumn], r]));
      expect(byId["e-upper"].currency).toBe("USD");
      expect(byId["e-lower"].currency).toBeNull();
      expect(byId["e-inject"].currency).toBeNull();
      expect(byId["e-absent"].currency).toBeNull(); // legacy no-currency stays NULL, as before
    });
  }
});

describe("pg_input_is_valid out-of-range behavior (empirical anchor)", () => {
  it("returns false for a syntactically numeric value that exceeds the target type's range", async () => {
    // The safe-cast pattern relies on pg_input_is_valid rejecting not just garbage
    // like "abc" but also out-of-range numerics — verify that empirically here so the
    // model tests above aren't resting on an assumption.
    const res = await pool.query(
      `select pg_input_is_valid($1, 'bigint') as as_bigint,
              pg_input_is_valid($1, 'integer') as as_integer`,
      [OUT_OF_RANGE],
    );
    expect(res.rows[0].as_bigint).toBe(false);
    expect(res.rows[0].as_integer).toBe(false);
  });
});
