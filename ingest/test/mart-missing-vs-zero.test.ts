import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { loadModel } from "./helpers/load-model.js";

// L3 (missing is not zero): after L2, malformed amounts sit in staging as NULLs. The mart's
// `coalesce(sum(...), 0)` renders those NULLs as confident zeros — an entity whose amounts
// are UNKNOWN is indistinguishable from an entity that owes nothing. These tests pin the
// L3 counters: null_amount_invoice_count / null_amount_deal_count / has_unusable_amounts
// make an entity with unusable amounts visibly incomplete instead of confidently zero.
// B2: the REAL mart text is loaded from disk via loadModel — no hand-mirrored SQL.
// Fixtures carry an explicit 'USD' currency: since the L5.1 retraction, any NULL-currency
// row refuses its source's sums (mart-currency.test.ts owns that), and these tests pin
// AMOUNT semantics — currency must not be the reason a sum goes NULL here.

let pool: pg.Pool;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ pool, cleanup } = await freshTestDb());
  // Fixture tables carry ONLY the columns customer_360 selects from each ref
  // (merge-resolution.test.ts technique, extended to the mart's full ref set).
  await pool.query(`
    create table tmp_canonical (company_id text primary key, canonical_id text not null);
    create table tmp_companies (company_id text primary key, name text not null, domain text);
    create table tmp_resolution (
      source text not null, source_entity_id text not null,
      resolved_entity_id text not null, matched_tier int not null
    );
    create table tmp_billing_customers (customer_id text primary key, name text, domain text);
    create table tmp_tickets (
      ticket_id text, requester_id text, company_name text, domain text,
      status text, solved_at timestamptz, sla_due_at timestamptz
    );
    create table tmp_deals (deal_id text, company_id text, status text, amount_cents bigint, currency text);
    create table tmp_invoices (invoice_id text, customer_id text, amount_cents bigint, status text, currency text);
    create table tmp_payments (customer_id text, status text);
    create table tmp_csat (ticket_id text, score int);
    -- A6 mechanical: customer_360 gained ref('stg_sheets__rows'); empty fixture only —
    -- the sheet column pins live in sheet-mart-oracle.test.ts.
    create table tmp_sheet_rows (
      row_key text primary key, client_email text, client_name text, company_name text,
      amount_cents bigint, currency text, status text, label text, content_hash text,
      client_key text not null, detected_at timestamptz not null default now(),
      received_at timestamptz not null default now()
    );
  `);
});

afterEach(async () => {
  await cleanup();
});

// The REAL mart, loaded from disk (all 9 refs → tmp_ fixtures) — no mirror to drift.
const MART_SQL = loadModel("models/marts/customer_360.sql", {
  int_crm__canonical_companies: "tmp_canonical",
  stg_crm__companies: "tmp_companies",
  identity_resolution: "tmp_resolution",
  stg_billing__customers: "tmp_billing_customers",
  stg_support__tickets: "tmp_tickets",
  stg_crm__deals: "tmp_deals",
  stg_billing__invoices: "tmp_invoices",
  stg_billing__payments: "tmp_payments",
  stg_support__csat: "tmp_csat",
  stg_sheets__rows: "tmp_sheet_rows",
});

/** One CRM entity (self-canonical) resolved to one billing customer. */
const seedEntity = async (companyId: string, customerId: string): Promise<void> => {
  await pool.query("insert into tmp_canonical values ($1, $1)", [companyId]);
  await pool.query("insert into tmp_companies values ($1, $2, $3)", [
    companyId,
    `Co ${companyId}`,
    `${companyId.toLowerCase()}.example.com`,
  ]);
  await pool.query("insert into tmp_resolution values ('billing', $1, $2, 1)", [
    customerId,
    companyId,
  ]);
};

const martRow = async (entityId: string): Promise<Record<string, unknown>> => {
  const res = await pool.query(`select * from (${MART_SQL}) m where entity_id = $1`, [entityId]);
  expect(res.rowCount).toBe(1);
  return res.rows[0];
};

describe("customer_360 — missing amount is not zero (L3)", () => {
  it("an entity with one NULL-amount invoice and one valid invoice: the sum keeps only the valid amount, and the NULL is COUNTED and FLAGGED — not silently absorbed into a confident total", async () => {
    await seedEntity("C-1", "cust-1");
    await pool.query(`
      insert into tmp_invoices values
        ('inv-1', 'cust-1', 4000, 'created', 'USD'),
        ('inv-2', 'cust-1', null, 'created', 'USD')
    `);

    const row = await martRow("C-1");
    expect(row.total_invoiced_cents).toBe("4000"); // only the usable amount
    expect(Number(row.null_amount_invoice_count)).toBe(1);
    expect(row.has_unusable_amounts).toBe(true);
  });

  it("a clean entity reports zero NULL-amount counts and flag false — the flag has no false positives", async () => {
    await seedEntity("C-2", "cust-2");
    await pool.query(`
      insert into tmp_invoices values ('inv-3', 'cust-2', 7000, 'paid', 'USD');
      insert into tmp_deals values ('d-1', 'C-2', 'open', 25000, 'USD');
    `);

    const row = await martRow("C-2");
    expect(row.total_invoiced_cents).toBe("7000");
    expect(Number(row.null_amount_invoice_count)).toBe(0);
    expect(Number(row.null_amount_deal_count)).toBe(0);
    expect(row.has_unusable_amounts).toBe(false);
  });

  it("a NULL-amount deal is counted and flags the entity, while the open-deal sum keeps only usable amounts", async () => {
    await seedEntity("C-3", "cust-3");
    await pool.query(`
      insert into tmp_deals values
        ('d-2', 'C-3', 'open', 30000, 'USD'),
        ('d-3', 'C-3', 'open', null, 'USD')
    `);

    const row = await martRow("C-3");
    expect(row.open_deal_amount_cents).toBe("30000");
    expect(Number(row.open_deal_count)).toBe(2); // the deal exists; only its amount is unusable
    expect(Number(row.null_amount_deal_count)).toBe(1);
    expect(row.has_unusable_amounts).toBe(true);
  });

  it("an entity with NO invoices at all is a true zero: count 0, flag false — zero-because-nothing stays distinguishable from zero-because-unusable", async () => {
    await seedEntity("C-4", "cust-4");

    const row = await martRow("C-4");
    expect(row.total_invoiced_cents).toBe("0");
    expect(Number(row.null_amount_invoice_count)).toBe(0);
    expect(row.has_unusable_amounts).toBe(false);
  });

  // Task 3 review I2 (latest-state displacement pin): the REAL stg_billing__invoices.sql
  // runs over raw fixture events, and its output feeds the REAL mart. A NEWER event with a
  // malformed amount displaces an OLDER good amount in staging's distinct-on — the mart
  // must degrade to a VISIBLE unknown: not the stale 5000, not a confident zero-with-no-flag.
  it("displacement: a newer malformed amount displaces an older good one — the mart reports flagged-unknown, NOT the stale good value and NOT an unflagged zero", async () => {
    await seedEntity("C-5", "cust-5");
    const insertRaw = async (
      eventId: string,
      eventType: string,
      occurredAt: string,
      amount: string,
    ): Promise<void> => {
      await pool.query(
        `insert into raw.raw_events (source, event_id, event_type, payload)
         values ('billing', $1, $2, $3::jsonb)`,
        [
          eventId,
          eventType,
          JSON.stringify({
            occurred_at: occurredAt,
            data: { id: "inv-9", customer_id: "cust-5", amount_cents: amount, currency: "USD" },
          }),
        ],
      );
    };
    // OLDER event: good amount. NEWER event (same invoice, later occurred_at): malformed.
    await insertRaw("evt-1", "invoice.created", "2026-01-05T00:00:00.000Z", "5000");
    await insertRaw("evt-2", "invoice.paid", "2026-01-06T00:00:00.000Z", "abc");

    // Chain the REAL staging model (raw → latest-state, L2 safe cast) into the mart fixture.
    await pool.query(`
      insert into tmp_invoices (invoice_id, customer_id, amount_cents, status, currency)
      select invoice_id, customer_id, amount_cents, status, currency
      from (${loadModel("models/staging/stg_billing__invoices.sql")}) s
    `);
    // Sanity: staging really did pick the newer row and NULL its amount.
    const stg = await pool.query("select * from tmp_invoices where invoice_id = 'inv-9'");
    expect(stg.rows[0].amount_cents).toBeNull();
    expect(stg.rows[0].status).toBe("paid");

    const row = await martRow("C-5");
    expect(row.total_invoiced_cents).not.toBe("5000"); // stale good value must NOT resurrect
    expect(row.total_invoiced_cents).toBe("0"); // the sum excludes the unusable amount...
    expect(Number(row.null_amount_invoice_count)).toBe(1); // ...but the zero is FLAGGED,
    expect(row.has_unusable_amounts).toBe(true); // never a confident zero-with-no-flag.
  });
});
