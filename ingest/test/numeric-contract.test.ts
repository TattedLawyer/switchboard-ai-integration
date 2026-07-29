import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type pg from "pg";
import type { Server } from "node:http";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp } from "../src/server.js";
import { replayQuarantined } from "../src/quarantine.js";
import { ingestEvent } from "../src/ingest-event.js";
import { secretForSource, signBody } from "../src/hmac.js";
import type { Source } from "../src/sources.js";
// Type-only (erased at runtime — the lazy-import rationale below is unaffected): used by
// the compile-time both-shape pin (review I2).
import type { FieldRule } from "../src/numeric-contract.js";

// Same resolution pattern as helpers/load-model.ts: the warehouse tree lives two levels up
// from this test file. The registry test below scans the REAL model text on disk, so a new
// model consuming an undeclared event_type fails the build — no mirror to drift.
const WAREHOUSE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../warehouse");

// Imported lazily: only the registry and unit-level tests need the contract module itself.
// The boundary tests below exercise the HTTP surface, so they report real accept/quarantine
// verdicts (not a load error) even when the module is absent — which is exactly what makes
// the RED run legible: every rejection test fails with "stored" where "quarantined" belongs.
const contractModule = () => import("../src/numeric-contract.js");

let pool: pg.Pool;
let cleanup: () => Promise<void>;
let srv: Server;
let port: number;

beforeAll(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
  const app = createIngestApp(pool);
  srv = app.listen(0);
  port = (srv.address() as { port: number }).port;
});
afterAll(async () => {
  srv.close();
  await cleanup();
});

const postSigned = async (source: Source, payload: unknown) => {
  const rawBody = JSON.stringify(payload);
  return fetch(`http://127.0.0.1:${port}/webhooks/${source}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-switchboard-signature": signBody(rawBody, secretForSource(source)),
    },
    body: rawBody,
  });
};

const evt = (id: string, type: string, data: Record<string, unknown>) => ({
  event_id: id,
  event_type: type,
  // Relative on purpose: a literal timestamp would age out of the A6 window.
  occurred_at: new Date().toISOString(),
  data,
});

// Shared assertion for every rejection: 202 {quarantined:true}, a quarantine row whose
// reason names the offending field, and raw.raw_events untouched.
async function expectQuarantinedNaming(id: string, res: Response, field: string): Promise<void> {
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ quarantined: true });
  const q = await pool.query(
    "select reason from ingest.quarantine where payload->>'event_id' = $1",
    [id],
  );
  expect(q.rowCount).toBe(1);
  expect(q.rows[0].reason).toContain("schema validation failed");
  expect(q.rows[0].reason).toContain(field);
  const raw = await pool.query("select 1 from raw.raw_events where event_id = $1", [id]);
  expect(raw.rowCount).toBe(0);
}

describe("L1 numeric contract at the trust boundary", () => {
  describe("rejections: every non-storable-integer shape of a declared money field quarantines", () => {
    const moneyCases: Array<{ label: string; id: string; data: Record<string, unknown> }> = [
      { label: "string amount ('abc')", id: "evt-nc-str", data: { amount_cents: "abc" } },
      { label: "float amount (1000.5)", id: "evt-nc-float", data: { amount_cents: 1000.5 } },
      { label: "null amount", id: "evt-nc-null", data: { amount_cents: null } },
      { label: "boolean amount (true)", id: "evt-nc-bool", data: { amount_cents: true } },
      { label: "negative amount on an unsigned surface (-500000)", id: "evt-nc-neg", data: { amount_cents: -500000 } },
      { label: "beyond safe-integer / bigint overflow (1e20)", id: "evt-nc-big", data: { amount_cents: 1e20 } },
      { label: "required amount absent", id: "evt-nc-absent", data: {} },
    ];
    for (const { label, id, data } of moneyCases) {
      it(`invoice.created with ${label} is quarantined, names amount_cents, raw untouched`, async () => {
        const res = await postSigned("billing", evt(id, "invoice.created", data));
        await expectQuarantinedNaming(id, res, "amount_cents");
      });
    }

    for (const [id, score] of [
      ["evt-nc-score-lo", 0],
      ["evt-nc-score-hi", 6],
    ] as const) {
      it(`csat.recorded with score ${score} (outside declared 1-5 scale) is quarantined, names score`, async () => {
        const res = await postSigned("support", evt(id, "csat.recorded", { score }));
        await expectQuarantinedNaming(id, res, "score");
      });
    }
  });

  describe("over-rejection guards: the contract must not reject what it exists to protect", () => {
    it("a valid integer amount_cents still ingests", async () => {
      const res = await postSigned("billing", evt("evt-nc-ok", "invoice.created", { amount_cents: 12500 }));
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ stored: true });
      const raw = await pool.query("select 1 from raw.raw_events where event_id = 'evt-nc-ok'");
      expect(raw.rowCount).toBe(1);
    });

    it("payment.succeeded above plausibleMax (100_000_000) INGESTS — implausible is warned, never quarantined", async () => {
      const res = await postSigned(
        "billing",
        evt("evt-nc-implausible", "payment.succeeded", { amount_cents: 100_000_000 }),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ stored: true });
      const raw = await pool.query("select 1 from raw.raw_events where event_id = 'evt-nc-implausible'");
      expect(raw.rowCount).toBe(1);
    });

    it("an UNKNOWN event_type with garbage numeric data ingests unchanged — a vendor shipping a new type must never cause a feed-wide quarantine", async () => {
      const res = await postSigned(
        "billing",
        evt("evt-nc-unknown", "invoice.refunded", { amount_cents: "not-even-a-number", junk: -1.5 }),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ stored: true });
      const raw = await pool.query("select 1 from raw.raw_events where event_id = 'evt-nc-unknown'");
      expect(raw.rowCount).toBe(1);
    });

    it("required: false with the field absent passes (unit pin — no production type declares it yet, so the mechanism is pinned with a synthetic entry)", async () => {
      const { NUMERIC_CONTRACT, numericContractViolation } = await contractModule();
      const key = "synthetic.sparse";
      (NUMERIC_CONTRACT as Record<string, unknown>)[key] = {
        delta_cents: { integer: true, required: false, signed: true },
      };
      try {
        // Sparse change-only payload: absence of an optional field is not a violation.
        expect(numericContractViolation(key, {})).toBeNull();
        // Signed surface: negatives pass.
        expect(numericContractViolation(key, { delta_cents: -250 })).toBeNull();
        // But when PRESENT the field is still integer-checked.
        expect(numericContractViolation(key, { delta_cents: 2.5 })).not.toBeNull();
      } finally {
        delete (NUMERIC_CONTRACT as Record<string, unknown>)[key];
      }
    });
  });

  describe("violation rendering is total and bounded (security review M1/L1)", () => {
    it("a 7000-deep nested amount_cents returns a violation naming amount_cents and does NOT throw", async () => {
      const { numericContractViolation } = await contractModule();
      // Past V8's JSON.stringify recursion cliff (~6.6k): a throwing renderer here would
      // propagate through safeParse and wedge the backfill poll loop.
      let deep: unknown = 0;
      for (let i = 0; i < 7000; i++) deep = [deep];
      const violation = numericContractViolation("deal.updated", { amount_cents: deep });
      expect(violation).not.toBeNull();
      expect(violation!.field).toBe("amount_cents");
      expect(violation!.reason).toContain("amount_cents");
    });

    it("a 10KB string value produces a bounded reason (≤ ~200 chars), not a payload dump", async () => {
      const { numericContractViolation } = await contractModule();
      const violation = numericContractViolation("deal.updated", { amount_cents: "x".repeat(10 * 1024) });
      expect(violation).not.toBeNull();
      expect(violation!.reason).toContain("amount_cents");
      expect(violation!.reason.length).toBeLessThanOrEqual(200);
    });
  });

  describe("replay door", () => {
    it("a quarantined bad-amount payload stays 'still-invalid' on replay — the contract lives on the shared schema, so no door can drift", async () => {
      const bad = evt("evt-nc-replay", "invoice.created", { amount_cents: "abc" });
      const res = await postSigned("billing", bad);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ quarantined: true });

      const row = await pool.query(
        "select id from ingest.quarantine where payload->>'event_id' = 'evt-nc-replay'",
      );
      expect(row.rowCount).toBe(1);

      // This test FAILS if L1 is ever applied to only the webhook door: replay runs the same
      // eventSchema.safeParse, so a bad amount must never re-enter raw via an operator replay.
      const result = await replayQuarantined(pool, row.rows[0].id, ingestEvent);
      expect(result).toBe("still-invalid");
      const raw = await pool.query("select 1 from raw.raw_events where event_id = 'evt-nc-replay'");
      expect(raw.rowCount).toBe(0);
    });
  });

  describe("declared string fields: currency validated at the door (Task A2)", () => {
    // The count-presence trade, accepted and documented: quarantining an event over a bad
    // currency removes its NON-monetary facts until replay. That is why ABSENT must pass
    // (legacy pre-currency events flow untouched) and why the reason must NAME the field.
    describe("rejections: present-but-malformed currency quarantines event-level, naming currency", () => {
      const currencyCases: Array<{ label: string; id: string; currency: unknown }> = [
        { label: "lowercase 'usd'", id: "evt-sc-lower", currency: "usd" },
        { label: "injection garbage 'EUR;drop table x'", id: "evt-sc-inject", currency: "EUR;drop table x" },
        { label: "overlong junk string (500 chars)", id: "evt-sc-long", currency: "Z".repeat(500) },
        { label: "non-string 123", id: "evt-sc-nonstr", currency: 123 },
        { label: "trailing space 'USD ' (pattern is fully anchored)", id: "evt-sc-trail", currency: "USD " },
        { label: "embedded match 'XUSDX' (pattern is fully anchored)", id: "evt-sc-anchor", currency: "XUSDX" },
      ];
      for (const { label, id, currency } of currencyCases) {
        it(`invoice.created with ${label} is quarantined, names currency, raw untouched`, async () => {
          const res = await postSigned("billing", evt(id, "invoice.created", { amount_cents: 12500, currency }));
          await expectQuarantinedNaming(id, res, "currency");
        });
      }

      it("invoice.voided with lowercase 'chf' is quarantined — the rule is live on every declared type, not just invoice.created", async () => {
        const res = await postSigned(
          "billing",
          evt("evt-sc-voided", "invoice.voided", { amount_cents: 100, currency: "chf" }),
        );
        await expectQuarantinedNaming("evt-sc-voided", res, "currency");
      });

      it("the reason states the expected shape and the got-value, for the operator", async () => {
        // Self-sufficient: seeds its own quarantine row rather than reading the sibling
        // rejection test's write (order/skip coupling — review M1).
        const res = await postSigned(
          "billing",
          evt("evt-sc-reason", "invoice.created", { amount_cents: 100, currency: "usd" }),
        );
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ quarantined: true });
        const q = await pool.query(
          "select reason from ingest.quarantine where payload->>'event_id' = 'evt-sc-reason'",
        );
        expect(q.rowCount).toBe(1);
        expect(q.rows[0].reason).toContain("^[A-Z]{3}$");
        expect(q.rows[0].reason).toContain('"usd"');
      });
    });

    describe("over-rejection guards: absent passes, valid codes pass, unknown types pass", () => {
      it("ABSENT currency on invoice.created still ingests — legacy pre-currency events must flow (load-bearing)", async () => {
        const res = await postSigned("billing", evt("evt-sc-absent", "invoice.created", { amount_cents: 9900 }));
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ stored: true });
        const raw = await pool.query("select 1 from raw.raw_events where event_id = 'evt-sc-absent'");
        expect(raw.rowCount).toBe(1);
      });

      for (const [id, source, type, currency] of [
        ["evt-sc-usd", "billing", "invoice.created", "USD"],
        ["evt-sc-eur", "crm", "deal.updated", "EUR"],
        ["evt-sc-php", "billing", "invoice.paid", "PHP"],
      ] as const) {
        it(`valid currency ${currency} on ${type} ingests`, async () => {
          const res = await postSigned(source, evt(id, type, { amount_cents: 5000, currency }));
          expect(res.status).toBe(202);
          expect(await res.json()).toEqual({ stored: true });
          const raw = await pool.query("select 1 from raw.raw_events where event_id = $1", [id]);
          expect(raw.rowCount).toBe(1);
        });
      }

      it("an UNKNOWN event_type with garbage currency ingests untouched — new vendor types must never cause a feed-wide quarantine", async () => {
        const res = await postSigned(
          "billing",
          evt("evt-sc-unknown", "invoice.refunded", { amount_cents: 100, currency: "usd;drop" }),
        );
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ stored: true });
        const raw = await pool.query("select 1 from raw.raw_events where event_id = 'evt-sc-unknown'");
        expect(raw.rowCount).toBe(1);
      });
    });

    describe("robustness: rendering stays total at declared string fields", () => {
      it("a 7000-deep nested array as currency returns a violation naming currency and does NOT throw", async () => {
        const { numericContractViolation } = await contractModule();
        let deep: unknown = "USD";
        for (let i = 0; i < 7000; i++) deep = [deep];
        const violation = numericContractViolation("invoice.created", { amount_cents: 100, currency: deep });
        expect(violation).not.toBeNull();
        expect(violation!.field).toBe("currency");
        expect(violation!.reason).toContain("currency");
      });
    });

    describe("contract shape is compile-time discriminated (review I2 pin)", () => {
      it("a rule declaring BOTH shapes fails typecheck; valid shapes still compile", () => {
        // Valid single-shape rules must keep compiling — these lines guard the guard:
        const numeric: FieldRule = { integer: true, required: true, signed: false };
        const str: FieldRule = { type: "string", required: false, pattern: "^[A-Z]{3}$" };
        // The pin is self-enforcing: if `type?: never` is ever removed from
        // NumericFieldRule, the line below COMPILES and tsc fails the build with
        // "unused @ts-expect-error". Without the pin, a both-shape rule routes to the
        // string branch at runtime with every numeric constraint silently unenforced.
        // @ts-expect-error — integer constraints + type:"string" in one rule must not compile
        const bothShapes: FieldRule = { integer: true, required: true, type: "string", pattern: "^x$" };
        expect([numeric, str, bothShapes]).toHaveLength(3);
      });
    });

    describe("replay door", () => {
      it("a webhook-quarantined bad-currency event stays 'still-invalid' on replay", async () => {
        const bad = evt("evt-sc-replay", "invoice.created", { amount_cents: 100, currency: "usd" });
        const res = await postSigned("billing", bad);
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ quarantined: true });

        const row = await pool.query(
          "select id from ingest.quarantine where payload->>'event_id' = 'evt-sc-replay'",
        );
        expect(row.rowCount).toBe(1);
        const result = await replayQuarantined(pool, row.rows[0].id, ingestEvent);
        expect(result).toBe("still-invalid");
        const raw = await pool.query("select 1 from raw.raw_events where event_id = 'evt-sc-replay'");
        expect(raw.rowCount).toBe(0);
      });
    });
  });

  describe("registry completeness", () => {
    it("every event_type consumed by any warehouse model is declared in NUMERIC_CONTRACT", async () => {
      const { NUMERIC_CONTRACT } = await contractModule();
      const modelsDir = join(WAREHOUSE_DIR, "models");
      const files = readdirSync(modelsDir, { recursive: true })
        .map(String)
        .filter((f) => f.endsWith(".sql"));
      const consumed = new Set<string>();
      for (const f of files) {
        const sql = readFileSync(join(modelsDir, f), "utf8");
        for (const m of sql.matchAll(/'([a-z_]+\.[a-z_]+)'/g)) consumed.add(m[1]);
      }
      expect(consumed.size).toBeGreaterThanOrEqual(14); // 13 staging + company.merged; guards a silent scan break
      const declared = Object.keys(NUMERIC_CONTRACT);
      for (const type of consumed) {
        // NOT toHaveProperty: vitest treats "invoice.created" as a nested path.
        expect(declared, `event_type '${type}' is consumed by a warehouse model but undeclared`).toContain(type);
      }
    });
  });
});
