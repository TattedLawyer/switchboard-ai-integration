import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { loadModel } from "./helpers/load-model.js";

// L5 (currency carried, cross-currency sums refused): a total across two currencies is
// not a number, it is a mistake. When an entity's invoices (or deals) mix currencies,
// the money sums become NULL and has_mixed_currency flags the row — the mart must NEVER
// emit a confident cross-currency total. Single-currency entities keep their sums intact
// and expose the currency (billing_currency / deal_currency). The no-rows case stays a
// true 0 (not NULL): after L5, 0 = genuinely zero or no rows; NULL = currencies mixed.
// B2: the REAL mart text is loaded from disk via loadModel — no hand-mirrored SQL.

let pool: pg.Pool;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ pool, cleanup } = await freshTestDb());
  // Fixture tables carry ONLY the columns customer_360 selects from each ref
  // (mart-missing-vs-zero.test.ts technique; invoices/deals gain `currency` for L5).
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
    create table tmp_deals (
      deal_id text, company_id text, status text, amount_cents bigint, currency text
    );
    create table tmp_invoices (
      invoice_id text, customer_id text, amount_cents bigint, status text, currency text
    );
    create table tmp_payments (customer_id text, status text);
    create table tmp_csat (ticket_id text, score int);
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

describe("customer_360 — cross-currency sums are refused, currency is carried (L5)", () => {
  it("two invoices in different currencies: the invoice sums are NULL (never a mixed total), billing_currency is NULL, and has_mixed_currency flags the row", async () => {
    await seedEntity("C-1", "cust-1");
    await pool.query(`
      insert into tmp_invoices values
        ('inv-1', 'cust-1', 4000, 'paid',    'USD'),
        ('inv-2', 'cust-1', 6000, 'created', 'EUR')
    `);

    const row = await martRow("C-1");
    expect(row.total_invoiced_cents).toBeNull(); // 4000+6000 across USD/EUR is a lie
    expect(row.total_paid_cents).toBeNull();
    expect(row.billing_currency).toBeNull();
    expect(row.has_mixed_currency).toBe(true);
  });

  it("two OPEN deals in different currencies: open_deal_amount_cents is NULL, deal_currency is NULL, flag true — while the deal COUNT (currency-free) survives", async () => {
    await seedEntity("C-2", "cust-2");
    await pool.query(`
      insert into tmp_deals values
        ('d-1', 'C-2', 'open', 30000, 'USD'),
        ('d-2', 'C-2', 'open', 20000, 'EUR')
    `);

    const row = await martRow("C-2");
    expect(row.open_deal_amount_cents).toBeNull();
    expect(row.deal_currency).toBeNull();
    expect(row.has_mixed_currency).toBe(true);
    expect(Number(row.open_deal_count)).toBe(2); // counts are not money; they survive mixing
  });

  it("a single-currency entity keeps its sums intact, exposes the currency, and is not flagged", async () => {
    await seedEntity("C-3", "cust-3");
    await pool.query(`
      insert into tmp_invoices values
        ('inv-3', 'cust-3', 7000, 'paid', 'USD'),
        ('inv-4', 'cust-3', 3000, 'created', 'USD');
      insert into tmp_deals values ('d-3', 'C-3', 'open', 25000, 'USD');
    `);

    const row = await martRow("C-3");
    expect(row.total_invoiced_cents).toBe("10000");
    expect(row.total_paid_cents).toBe("7000");
    expect(row.open_deal_amount_cents).toBe("25000");
    expect(row.billing_currency).toBe("USD");
    expect(row.deal_currency).toBe("USD");
    expect(row.has_mixed_currency).toBe(false);
  });

  // All-USD invariance pin: for uniform-currency data the SUM columns must be byte-identical
  // to the pre-L5 mart. (At RED, the sum assertions here already pass — stated on purpose —
  // while billing_currency/deal_currency/has_mixed_currency fail as missing columns.)
  it("all-USD invariance: an all-USD entity's numbers are IDENTICAL to the pre-change mart output", async () => {
    await seedEntity("C-4", "cust-4");
    await pool.query(`
      insert into tmp_invoices values
        ('inv-5', 'cust-4', 120000, 'paid', 'USD'),
        ('inv-6', 'cust-4', 80000,  'created', 'USD'),
        ('inv-7', 'cust-4', null,   'created', 'USD');
      insert into tmp_deals values
        ('d-4', 'C-4', 'open', 500000, 'USD'),
        ('d-5', 'C-4', 'won',  900000, 'USD');
    `);

    const row = await martRow("C-4");
    // Pre-change expectations (pinned before the L5 restructure; must not drift):
    expect(row.total_invoiced_cents).toBe("200000");
    expect(row.total_paid_cents).toBe("120000");
    expect(row.open_deal_amount_cents).toBe("500000");
    expect(Number(row.open_invoice_count)).toBe(2);
    expect(Number(row.open_deal_count)).toBe(1);
    expect(Number(row.null_amount_invoice_count)).toBe(1); // L3 counters keep working
    expect(row.has_unusable_amounts).toBe(true);
    // New columns on clean single-currency data:
    expect(row.billing_currency).toBe("USD");
    expect(row.deal_currency).toBe("USD");
    expect(row.has_mixed_currency).toBe(false);
  });

  it("an entity with NO billing and NO deals still shows 0 sums (not NULL), NULL currencies, flag false — 0 stays 'genuinely nothing', NULL stays 'mixed'", async () => {
    await seedEntity("C-5", "cust-5");

    const row = await martRow("C-5");
    expect(row.total_invoiced_cents).toBe("0");
    expect(row.total_paid_cents).toBe("0");
    expect(row.open_deal_amount_cents).toBe("0");
    expect(row.billing_currency).toBeNull();
    expect(row.deal_currency).toBeNull();
    expect(row.has_mixed_currency).toBe(false);
  });
});
