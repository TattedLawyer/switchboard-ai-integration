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

  // Review C1/I3: mixing is PER SOURCE. A mixed source NULLs its own sums; the neighbor
  // source's sums are untouched (0 = no rows / genuine zero). This is exactly the shape
  // the original entity-level singular test would have false-positived on.
  it("PARTIALLY mixed (mixed invoices, NO deals): invoice sums NULL, but open_deal_amount_cents stays 0 (not NULL) — mixing never poisons the neighbor source", async () => {
    await seedEntity("C-6", "cust-6");
    await pool.query(`
      insert into tmp_invoices values
        ('inv-8', 'cust-6', 4000, 'paid',    'USD'),
        ('inv-9', 'cust-6', 6000, 'created', 'EUR')
    `);

    const row = await martRow("C-6");
    expect(row.total_invoiced_cents).toBeNull();
    expect(row.total_paid_cents).toBeNull();
    expect(row.open_deal_amount_cents).toBe("0"); // no deals = genuine 0, NOT NULL
    expect(row.has_mixed_currency).toBe(true);
  });

  it("BOTH sources mixed: all three sums NULL, flag true", async () => {
    await seedEntity("C-7", "cust-7");
    await pool.query(`
      insert into tmp_invoices values
        ('inv-10', 'cust-7', 4000, 'paid', 'USD'),
        ('inv-11', 'cust-7', 6000, 'paid', 'EUR');
      insert into tmp_deals values
        ('d-6', 'C-7', 'open', 30000, 'USD'),
        ('d-7', 'C-7', 'open', 20000, 'EUR');
    `);

    const row = await martRow("C-7");
    expect(row.total_invoiced_cents).toBeNull();
    expect(row.total_paid_cents).toBeNull();
    expect(row.open_deal_amount_cents).toBeNull();
    expect(row.has_mixed_currency).toBe(true);
  });

  // ── External review F2: count(distinct) ignores NULLs, so {USD, NULL} used to count
  // as ONE currency and the NULL-currency amount summed into a confident 'USD' total.
  // Semantics (post L5.1 retraction): a source is summable iff at most one distinct
  // known currency AND zero NULL-currency rows (no-rows stays a true 0). Known + unknown
  // = MIXED; uniformly-unknown = refused but NOT mixed (see the retraction test below).
  it("F2: a known currency plus an unknown one (USD + NULL invoices) is MIXED — sums NULL, billing_currency NULL, flag true", async () => {
    await seedEntity("C-12", "cust-12");
    await pool.query(`
      insert into tmp_invoices values
        ('inv-18', 'cust-12', 4000, 'paid',    'USD'),
        ('inv-19', 'cust-12', 6000, 'created', null)
    `);

    const row = await martRow("C-12");
    expect(row.total_invoiced_cents).toBeNull(); // the NULL-currency 6000 could be any currency
    expect(row.total_paid_cents).toBeNull();
    expect(row.billing_currency).toBeNull(); // 'USD' is not the whole truth
    expect(row.has_mixed_currency).toBe(true);
  });

  // L5.1 RETRACTED (primary-source research; Michael's call): an unknown-unit total is a
  // guess wearing a number's clothes — enterprise practice (JD Edwards "hash totals",
  // D365's convert-or-filter rule, Stripe's per-currency balances) has NO path where an
  // unknown-unit sum is presented as a money total, and two unknown rows are not provably
  // the same currency. Uniformly-unknown now REFUSES: sums NULL, label NULL. It is still
  // NOT "mixed" (nothing known contradicts anything) — the null_currency_*_count columns
  // and the report's unknown-currency flag carry the story.
  it("L5.1 retraction: uniformly-unknown currency (all invoices NULL) refuses — sums NULL, label NULL, flag false, unknown rows counted", async () => {
    await seedEntity("C-13", "cust-13");
    await pool.query(`
      insert into tmp_invoices values
        ('inv-20', 'cust-13', 4000, 'paid',    null),
        ('inv-21', 'cust-13', 6000, 'created', null)
    `);

    const row = await martRow("C-13");
    expect(row.total_invoiced_cents).toBeNull(); // 4000 + 6000 of unknown units is not a number
    expect(row.total_paid_cents).toBeNull();
    expect(row.billing_currency).toBeNull();
    expect(row.has_mixed_currency).toBe(false); // all-unknown is NOT mixed — just unknown
    expect(Number(row.null_currency_invoice_count)).toBe(2); // the visible bucket tells the story
  });

  it("F2 deal-side analog: an open USD deal plus an open NULL-currency deal is MIXED — open_deal_amount_cents NULL, deal_currency NULL, flag true", async () => {
    await seedEntity("C-14", "cust-14");
    await pool.query(`
      insert into tmp_deals values
        ('d-10', 'C-14', 'open', 30000, 'USD'),
        ('d-11', 'C-14', 'open', 20000, null)
    `);

    const row = await martRow("C-14");
    expect(row.open_deal_amount_cents).toBeNull();
    expect(row.deal_currency).toBeNull();
    expect(row.has_mixed_currency).toBe(true);
    expect(Number(row.open_deal_count)).toBe(2); // counts are not money; they survive
  });
});

// External review F3: stg_support__csat.score is nullable since the safe-cast, and
// avg() silently skips NULLs — the average is correct over usable scores, but the
// skipped rows were undisclosed. null_score_count makes them visible.
describe("customer_360 — avg_csat over NULL scores is disclosed (F3)", () => {
  it("2 valid scores (4,5) + 3 NULL-score csat rows: avg_csat is 4.50 over the usable scores, null_score_count discloses the 3", async () => {
    await seedEntity("C-15", "cust-15");
    await pool.query(`insert into tmp_resolution values ('support', 'req-15', 'C-15', 1)`);
    await pool.query(`
      insert into tmp_tickets (ticket_id, requester_id, status) values
        ('t-1', 'req-15', 'solved'), ('t-2', 'req-15', 'solved'), ('t-3', 'req-15', 'solved'),
        ('t-4', 'req-15', 'solved'), ('t-5', 'req-15', 'solved');
      insert into tmp_csat values
        ('t-1', 4), ('t-2', 5), ('t-3', null), ('t-4', null), ('t-5', null)
    `);

    const row = await martRow("C-15");
    expect(row.avg_csat).toBe("4.50"); // avg stays over usable scores — correct, now disclosed
    expect(Number(row.null_score_count)).toBe(3);
  });

  it("an entity with no csat rows at all reports null_score_count 0 (not NULL)", async () => {
    await seedEntity("C-16", "cust-16");

    const row = await martRow("C-16");
    expect(row.avg_csat).toBeNull();
    expect(Number(row.null_score_count)).toBe(0);
  });
});

// Research addendum: refusing unknown-currency rows is not enough — dimensional-model
// practice gives unknowns an explicit, VISIBLE bucket, and an average must carry its
// base size. The mart already counts these internally; consumers must see them.
describe("customer_360 — unknown-currency rows and the CSAT base are visibly counted (addendum)", () => {
  it("USD + NULL invoices: null_currency_invoice_count is 1 even while the sums stay refused", async () => {
    await seedEntity("C-17", "cust-17");
    await pool.query(`
      insert into tmp_invoices values
        ('inv-22', 'cust-17', 4000, 'paid', 'USD'),
        ('inv-23', 'cust-17', 6000, 'paid', null)
    `);

    const row = await martRow("C-17");
    expect(row.total_invoiced_cents).toBeNull(); // refusal unchanged
    expect(Number(row.null_currency_invoice_count)).toBe(1);
    expect(Number(row.null_currency_deal_count)).toBe(0);
  });

  it("USD + NULL open deals: null_currency_deal_count is 1 while open_deal_amount_cents stays refused", async () => {
    await seedEntity("C-18", "cust-18");
    await pool.query(`
      insert into tmp_deals values
        ('d-12', 'C-18', 'open', 30000, 'USD'),
        ('d-13', 'C-18', 'open', 20000, null)
    `);

    const row = await martRow("C-18");
    expect(row.open_deal_amount_cents).toBeNull();
    expect(Number(row.null_currency_deal_count)).toBe(1);
    expect(Number(row.null_currency_invoice_count)).toBe(0);
  });

  it("uniformly-unknown invoices (L5.1 retracted): the total refuses AND the count says how many rows are unknown-currency (2)", async () => {
    await seedEntity("C-19", "cust-19");
    await pool.query(`
      insert into tmp_invoices values
        ('inv-24', 'cust-19', 4000, 'paid', null),
        ('inv-25', 'cust-19', 6000, 'paid', null)
    `);

    const row = await martRow("C-19");
    expect(row.total_invoiced_cents).toBeNull(); // unknown units are counted, never totaled
    expect(Number(row.null_currency_invoice_count)).toBe(2);
  });

  it("a clean all-USD entity and a no-billing entity both report 0 counters — the LEFT-JOIN null-extended row is NOT an unknown currency", async () => {
    await seedEntity("C-20", "cust-20");
    await pool.query(`
      insert into tmp_invoices values ('inv-26', 'cust-20', 4000, 'paid', 'USD');
      insert into tmp_deals values ('d-14', 'C-20', 'open', 30000, 'USD')
    `);
    await seedEntity("C-21", "cust-21"); // billing link, zero invoices, zero deals

    const clean = await martRow("C-20");
    expect(Number(clean.null_currency_invoice_count)).toBe(0);
    expect(Number(clean.null_currency_deal_count)).toBe(0);

    const empty = await martRow("C-21");
    expect(Number(empty.null_currency_invoice_count)).toBe(0);
    expect(Number(empty.null_currency_deal_count)).toBe(0);
  });

  it("CSAT base size: 2 valid + 3 NULL scores → csat_score_count 2 (the usable base under avg_csat); a no-csat entity reports 0", async () => {
    await seedEntity("C-22", "cust-22");
    await pool.query(`insert into tmp_resolution values ('support', 'req-22', 'C-22', 1)`);
    await pool.query(`
      insert into tmp_tickets (ticket_id, requester_id, status) values
        ('t-6', 'req-22', 'solved'), ('t-7', 'req-22', 'solved'), ('t-8', 'req-22', 'solved'),
        ('t-9', 'req-22', 'solved'), ('t-10', 'req-22', 'solved');
      insert into tmp_csat values
        ('t-6', 4), ('t-7', 5), ('t-8', null), ('t-9', null), ('t-10', null)
    `);
    await seedEntity("C-23", "cust-23");

    const row = await martRow("C-22");
    expect(row.avg_csat).toBe("4.50");
    expect(Number(row.csat_score_count)).toBe(2);
    expect(Number(row.null_score_count)).toBe(3);

    const none = await martRow("C-23");
    expect(none.avg_csat).toBeNull();
    expect(Number(none.csat_score_count)).toBe(0);
  });
});

// Review I3: the dbt singular test's own predicate, exercised in vitest (no local dbt
// binary — this is its only CI-speed execution). The REAL test SQL is loaded from disk;
// loadModel strips the config() block, so severity does not interfere. The mart is
// materialized into tmp_mart so the corrupted-mart case can UPDATE it.
const SINGULAR_SQL = loadModel("tests/assert_no_mixed_currency_totals.sql", {
  customer_360: "tmp_mart",
  identity_resolution: "tmp_resolution",
  stg_billing__invoices: "tmp_invoices",
  stg_crm__deals: "tmp_deals",
  int_crm__canonical_companies: "tmp_canonical",
});

describe("assert_no_mixed_currency_totals — the singular test's predicate itself", () => {
  it("returns ZERO rows against a correct mart — including the partially-mixed shape that false-positived the original entity-level predicate (C1)", async () => {
    // C1's exact false-positive shape: mixed invoices, no deals → open_deal_amount_cents = 0.
    await seedEntity("C-8", "cust-8");
    await pool.query(`
      insert into tmp_invoices values
        ('inv-12', 'cust-8', 4000, 'paid', 'USD'),
        ('inv-13', 'cust-8', 6000, 'paid', 'EUR')
    `);
    // And the mirror shape: mixed deals, billing link with no invoices → invoice sums = 0.
    await seedEntity("C-9", "cust-9");
    await pool.query(`
      insert into tmp_deals values
        ('d-8', 'C-9', 'open', 30000, 'USD'),
        ('d-9', 'C-9', 'open', 20000, 'EUR')
    `);

    await pool.query(`create table tmp_mart as ${MART_SQL}`);
    const res = await pool.query(SINGULAR_SQL);
    expect(res.rows).toEqual([]); // correct mart → nothing to report
  });

  it("planted counter-example: a corrupted mart where a KNOWN+UNKNOWN-currency entity carries a non-NULL total IS returned — the predicate sees NULL-currency mixing (F2)", async () => {
    // External review F2, singular-test side: count(distinct) ignores NULLs, so the old
    // predicate (count(distinct currency) > 1) classified {USD, NULL} as single-currency
    // and would wave a leaked cross-currency total straight through.
    await seedEntity("C-11", "cust-11");
    await pool.query(`
      insert into tmp_invoices values
        ('inv-16', 'cust-11', 4000, 'paid', 'USD'),
        ('inv-17', 'cust-11', 6000, 'paid', null)
    `);

    await pool.query(`create table tmp_mart as ${MART_SQL}`);
    // Corrupt the mart: a confident total over a known + unknown currency leaked out.
    await pool.query(
      `update tmp_mart set total_invoiced_cents = 999999 where entity_id = 'C-11'`,
    );

    const res = await pool.query(SINGULAR_SQL);
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].entity_id).toBe("C-11");
    expect(res.rows[0].mixed_source).toBe("billing");
  });

  it("planted counter-example (L5.1 retraction): a corrupted mart where a UNIFORMLY-unknown-currency entity carries a non-NULL total IS returned — unknown-unit sums are offenders too", async () => {
    await seedEntity("C-24", "cust-24");
    await pool.query(`
      insert into tmp_invoices values
        ('inv-27', 'cust-24', 4000, 'paid', null),
        ('inv-28', 'cust-24', 6000, 'paid', null)
    `);

    await pool.query(`create table tmp_mart as ${MART_SQL}`);
    // Corrupt the mart: an unknown-unit total leaked out as if it were money.
    await pool.query(
      `update tmp_mart set total_invoiced_cents = 999999 where entity_id = 'C-24'`,
    );

    const res = await pool.query(SINGULAR_SQL);
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].entity_id).toBe("C-24");
    expect(res.rows[0].mixed_source).toBe("billing");
  });

  it("planted counter-example: a corrupted mart where a mixed-billing entity carries a non-NULL total_invoiced_cents IS returned — the test can fail", async () => {
    await seedEntity("C-10", "cust-10");
    await pool.query(`
      insert into tmp_invoices values
        ('inv-14', 'cust-10', 4000, 'paid', 'USD'),
        ('inv-15', 'cust-10', 6000, 'paid', 'EUR')
    `);

    await pool.query(`create table tmp_mart as ${MART_SQL}`);
    // Corrupt the mart: pretend the guard was removed and a cross-currency sum leaked out.
    await pool.query(
      `update tmp_mart set total_invoiced_cents = 999999 where entity_id = 'C-10'`,
    );

    const res = await pool.query(SINGULAR_SQL);
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].entity_id).toBe("C-10");
    expect(res.rows[0].mixed_source).toBe("billing"); // mixing re-derived from staging, not the mart's flag
  });
});
