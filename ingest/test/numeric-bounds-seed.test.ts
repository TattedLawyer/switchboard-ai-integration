import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { loadModel } from "./helpers/load-model.js";
import {
  NUMERIC_BOUNDS_SEED_PATH,
  createIso4217Fixture,
  createNumericBoundsFixture,
  ISO_4217_REF,
  readNumericBoundsSeed,
  type NumericBoundsSeedRow,
} from "./helpers/numeric-bounds.js";
import { NUMERIC_CONTRACT } from "../src/numeric-contract.js";

// Wave-5 bound emission (Task G): the numeric contract's quantitative bounds reach dbt
// as the numeric_bounds SEED, emitted from ingest/src/numeric-contract.ts — never a
// third hand-copy. These pins are the consistency mechanism the KNOWN-ISSUES debt asked
// for ("nothing mechanically diffs them"): the committed seed must equal the contract,
// row for row and byte for byte, and no warehouse SQL may re-type a bound. A drift in
// either direction reds the suite.

const WAREHOUSE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../warehouse");
const warehouseText = (relPath: string): string => readFileSync(join(WAREHOUSE_DIR, relPath), "utf8");

// The oracle: derive the expected seed rows from the CONTRACT OBJECT itself (not from
// the emitter — the byte pin below covers the emitter; this derivation breaks the
// circularity, so an emitter that silently dropped rows still reds here).
const expectedBoundRows = (): NumericBoundsSeedRow[] => {
  const rows: NumericBoundsSeedRow[] = [];
  for (const [eventType, contract] of Object.entries(NUMERIC_CONTRACT)) {
    for (const [field, rule] of Object.entries(contract)) {
      if (rule.type === "string") continue;
      const plausible = rule.plausibleMax ?? null; // undefined and null both mean "no bound"
      const hasScale = rule.min !== undefined || rule.max !== undefined;
      if (plausible === null && !hasScale) continue;
      rows.push({
        event_type: eventType,
        field,
        plausible_max: plausible,
        scale_min: rule.min ?? null,
        scale_max: rule.max ?? null,
      });
    }
  }
  return rows.sort((a, b) => a.event_type.localeCompare(b.event_type) || a.field.localeCompare(b.field));
};

describe("numeric_bounds seed — the emitted-bound consistency pin (contract value == dbt value, mechanically)", () => {
  it("the committed seed's rows are EXACTLY the contract's declared quantitative bounds — both directions (a bound changed, added, or dropped in one place only is a red suite)", () => {
    expect(readNumericBoundsSeed()).toEqual(expectedBoundRows());
  });

  it("the committed CSV is byte-identical to the emitter's rendering — a stale or hand-edited seed is a red suite, and the fix is re-running the generator", async () => {
    const { renderNumericBoundsCsv } = await import("../src/numeric-bounds-seed.js");
    expect(readFileSync(NUMERIC_BOUNDS_SEED_PATH, "utf8")).toBe(renderNumericBoundsCsv());
  });

  it("spot pin on the researched values shipping today: the Stripe-style 8-digit charge bound (99_999_999) and the csat 1..5 scale — an accidental contract edit reds here by name", () => {
    const rows = readNumericBoundsSeed();
    const byKey = new Map(rows.map((r) => [`${r.event_type}.${r.field}`, r]));
    for (const t of ["charge.succeeded", "charge.failed", "invoice.finalized", "payment.succeeded", "payment.failed"]) {
      expect(byKey.get(`${t}.amount_cents`)?.plausible_max).toBe(99_999_999);
    }
    expect(byKey.get("csat.recorded.score")).toEqual({
      event_type: "csat.recorded",
      field: "score",
      plausible_max: null,
      scale_min: 1,
      scale_max: 5,
    });
  });
});

describe("no warehouse SQL re-types a contract bound (the hand-copy class is closed, not just synced)", () => {
  it("assert_amounts_plausible carries no hand-typed ceiling — it surfaces the staging-derived is_unlikely_amount flag", () => {
    const sql = warehouseText("tests/assert_amounts_plausible.sql");
    expect(sql).not.toContain("99999999");
    expect(sql).toContain("is_unlikely_amount");
  });

  it("assert_csat_in_scale reads the seed's scale bounds, not literals", () => {
    const sql = warehouseText("tests/assert_csat_in_scale.sql");
    expect(sql).not.toMatch(/between\s+1\s+and\s+5/i);
    expect(sql).toContain("numeric_bounds");
  });

  it("both bounded staging models join ref('numeric_bounds') and re-type nothing", () => {
    for (const p of ["models/staging/stg_billing__payments.sql", "models/staging/stg_billing__invoices.sql"]) {
      const sql = warehouseText(p);
      expect(sql, p).toContain("ref('numeric_bounds')");
      expect(sql, p).not.toContain("99999999");
    }
  });

  it("NO .sql anywhere under warehouse/ re-types a bound literal — tree-wide sweep, so a NEW model cannot reopen the hand-copy class (close F6; the named-file checks above pin the positive shape, this pins the whole tree's negative)", () => {
    // target/ holds dbt's COMPILED copies of these same files (a legitimate literal there
    // is just the seed's own rendering); everything else under warehouse/ is source text.
    const skipDirs = new Set(["target", "logs", "dbt_packages"]);
    const sqlFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!skipDirs.has(entry.name)) walk(join(dir, entry.name));
        } else if (entry.name.endsWith(".sql")) {
          sqlFiles.push(join(dir, entry.name));
        }
      }
    };
    walk(WAREHOUSE_DIR);
    // The sweep must be sweeping something, or a moved directory turns it vacuous.
    expect(sqlFiles.length).toBeGreaterThanOrEqual(15);
    for (const p of sqlFiles) {
      const sql = readFileSync(p, "utf8");
      expect(sql, `${p} re-types the plausibleMax literal — join ref('numeric_bounds') instead`).not.toContain("99999999");
      expect(sql, `${p} re-types the csat scale — read the seed's scale bounds instead`).not.toMatch(/between\s+1\s+and\s+5/i);
    }
  });
});

// ── Row-grain behavior: the REAL staging SQL against the REAL committed seed ────────────

let pool: pg.Pool;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ pool, cleanup } = await freshTestDb());
  await createNumericBoundsFixture(pool); // the committed seed, as dbt would materialize it
  await createIso4217Fixture(pool);
});

afterEach(async () => {
  await cleanup();
});

const PAYMENTS_SQL = () => loadModel("models/staging/stg_billing__payments.sql", { numeric_bounds: "numeric_bounds" });
const INVOICES_SQL = () => loadModel("models/staging/stg_billing__invoices.sql", { numeric_bounds: "numeric_bounds", ...ISO_4217_REF });

const insertStripefeedRaw = async (
  eventId: string,
  eventType: string,
  data: Record<string, unknown>,
): Promise<void> => {
  await pool.query(
    `insert into raw.raw_events (source, event_id, event_type, payload)
     values ('stripefeed', $1, $2, $3::jsonb)`,
    [eventId, eventType, JSON.stringify({ occurred_at: "2026-01-05T00:00:00.000Z", data })],
  );
};

describe("is_unlikely_amount — the Unlikely Value flag at row grain (bound from the seed, never re-typed)", () => {
  it("payments: a charge AT the bound is NOT flagged, a charge ABOVE it is — on both charge.succeeded and charge.failed — and the flag is never NULL", async () => {
    await insertStripefeedRaw("evt-ub-1", "charge.succeeded", { id: "ch-bound", object: "charge", invoice_id: "inv-1", customer_id: "cust-1", amount_cents: 99_999_999 });
    await insertStripefeedRaw("evt-ub-2", "charge.succeeded", { id: "ch-above", object: "charge", invoice_id: "inv-2", customer_id: "cust-1", amount_cents: 100_000_000 });
    await insertStripefeedRaw("evt-ub-3", "charge.failed", { id: "ch-failed-above", object: "charge", invoice_id: "inv-3", customer_id: "cust-1", amount_cents: 100_000_000 });

    const res = await pool.query(`select * from (${PAYMENTS_SQL()}) m order by payment_id`);
    const byId = Object.fromEntries(res.rows.map((r) => [r.payment_id, r]));
    expect(byId["ch-bound"].is_unlikely_amount).toBe(false); // the bound itself is plausible
    expect(byId["ch-above"].is_unlikely_amount).toBe(true);
    expect(byId["ch-failed-above"].is_unlikely_amount).toBe(true);
    for (const r of res.rows) expect(typeof r.is_unlikely_amount, "flag must be two-valued, never NULL").toBe("boolean");
  });

  it("payments: a NULL amount (L2 safe-cast casualty) is NOT 'unlikely' — that row's story is has_unusable_amounts, and the two signals must not blur", async () => {
    await insertStripefeedRaw("evt-ub-4", "charge.succeeded", { id: "ch-null", object: "charge", invoice_id: "inv-4", customer_id: "cust-1", amount_cents: "abc" });

    const res = await pool.query(`select * from (${PAYMENTS_SQL()}) m where payment_id = 'ch-null'`);
    expect(res.rows[0].amount_cents).toBeNull();
    expect(res.rows[0].is_unlikely_amount).toBe(false);
  });

  it("invoices: invoice.finalized above the bound is flagged, at the bound is not", async () => {
    await insertStripefeedRaw("evt-ub-5", "invoice.finalized", { id: "inv-bound", object: "invoice", customer_id: "cust-2", amount_cents: 99_999_999, currency: "USD" });
    await insertStripefeedRaw("evt-ub-6", "invoice.finalized", { id: "inv-above", object: "invoice", customer_id: "cust-2", amount_cents: 100_000_000, currency: "USD" });

    const res = await pool.query(`select * from (${INVOICES_SQL()}) m order by invoice_id`);
    const byId = Object.fromEntries(res.rows.map((r) => [r.invoice_id, r]));
    expect(byId["inv-bound"].is_unlikely_amount).toBe(false);
    expect(byId["inv-above"].is_unlikely_amount).toBe(true);
  });
});

describe("assert_amounts_plausible — the warn surface reads the flag (real chain: raw → staging → warn rows)", () => {
  it("flagged payment AND invoice rows surface with kind + id + amount; at-bound rows do not", async () => {
    await insertStripefeedRaw("evt-wp-1", "charge.succeeded", { id: "ch-ok", object: "charge", invoice_id: "inv-1", customer_id: "cust-1", amount_cents: 99_999_999 });
    await insertStripefeedRaw("evt-wp-2", "charge.succeeded", { id: "ch-big", object: "charge", invoice_id: "inv-2", customer_id: "cust-1", amount_cents: 250_000_000 });
    await insertStripefeedRaw("evt-wp-3", "invoice.finalized", { id: "inv-big", object: "invoice", customer_id: "cust-1", amount_cents: 100_000_001, currency: "USD" });

    await pool.query(`create table t_payments as select * from (${PAYMENTS_SQL()}) m`);
    await pool.query(`create table t_invoices as select * from (${INVOICES_SQL()}) m`);
    const res = await pool.query(
      loadModel("tests/assert_amounts_plausible.sql", {
        stg_billing__payments: "t_payments",
        stg_billing__invoices: "t_invoices",
      }),
    );
    const rows = res.rows.map((r) => `${r.kind}:${r.id}`).sort();
    expect(rows).toEqual(["invoice:inv-big", "payment:ch-big"]);
  });
});

describe("assert_csat_in_scale — scale bounds arrive from the seed, and a missing bound is LOUD, never vacuous", () => {
  const seedCsat = async (): Promise<void> => {
    await pool.query(`create table t_csat (csat_id text, ticket_id text, score int)`);
    await pool.query(`
      insert into t_csat values
        ('s0', 't-0', 0), ('s1', 't-1', 1), ('s5', 't-5', 5), ('s6', 't-6', 6), ('snull', 't-9', null)
    `);
  };

  it("scores outside the seed's 1..5 surface; in-scale and NULL scores do not (NULL is the safe-cast's story)", async () => {
    await seedCsat();
    const res = await pool.query(
      loadModel("tests/assert_csat_in_scale.sql", { stg_support__csat: "t_csat", numeric_bounds: "numeric_bounds" }),
    );
    expect(res.rows.map((r) => r.csat_id).sort()).toEqual(["s0", "s6"]);
  });

  it("LOUDNESS GUARD: with the csat bound row absent from the seed relation, EVERY row surfaces — a dropped bound can never turn this invariant into a silent pass", async () => {
    await seedCsat();
    await pool.query(`create table nb_empty (like numeric_bounds including all)`);
    const res = await pool.query(
      loadModel("tests/assert_csat_in_scale.sql", { stg_support__csat: "t_csat", numeric_bounds: "nb_empty" }),
    );
    expect(res.rowCount).toBe(5); // all rows, including the NULL score — the failure is the missing bound, not the scores
  });
});
