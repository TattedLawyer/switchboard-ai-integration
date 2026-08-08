import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { loadModel } from "./helpers/load-model.js";

// ── Task F: the pinned name-normalization vectors (KNOWN-ISSUES "normalizer also fails
// on ordinary legal-name variants", verified empirically in the 2026-07-25 audit) ────────
//
// Each vector is one documented real-world failure of the pre-Task-F normalizer:
// trailing commas survived (so "Acme Plumbing, Inc." could never tier-2 match anything),
// Co/PLLC were not in the strip set, "&" and "and" never matched each other, doubled
// spaces were preserved, and ZWSP/NFC variants of visually identical names normalized
// differently (L2-G8). The L2-G4 strip-set drift (SQL stripped inc|llc|ltd|corp, the
// manifest resolver only inc|llc) is pinned by the ltd/corp vectors: BOTH normalizer
// copies must strip the SAME set.
//
// Three enforcement layers in this file:
//   1. SQL unit pins — the REAL norm_companies CTE text (extracted from
//      identity_resolution.sql on disk, never mirrored) evaluated per vector.
//   2. TS↔SQL agreement — the shared TS normalizer (mocks/core, the manifest resolver's
//      implementation) must emit the identical string per vector. verify-identity.ts
//      makes this pair CI-load-bearing: the oracle computes expectations with the TS
//      side and asserts them against the SQL side's output.
//   3. Tier-2 end-to-end per vector — company named with the RAW variant, entity named
//      with the NORMALIZED form: the match succeeds only if BOTH in-model normalizer
//      copies (norm_companies and the tier2_candidates join) agree. That is the drift
//      pin between the two in-file copies, functional rather than textual.
//
// The single-strip caveat is UNCHANGED and deliberate: stacked suffixes still normalize
// once per application ("Acme Inc Ltd" → "acme inc"), so norm(norm(x)) ≠ norm(x) for
// those inputs — the known-failing idempotence invariant in KNOWN-ISSUES stays excluded
// from the property suite on purpose.
import { NORMALIZATION_VECTORS, normalizeCompanyName } from "@switchboard/mock-core";

let pool: pg.Pool;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ pool, cleanup } = await freshTestDb());
});
afterEach(async () => {
  await cleanup();
});

const modelPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../warehouse/models/identity/identity_resolution.sql",
);

/** The REAL norm_companies CTE body, extracted from the model on disk (the crm_emails
 *  extraction precedent in merge-resolution.test.ts). Evaluated over a one-row fixture so
 *  each vector exercises the exact production expression. */
const normCompaniesSql = (): string => {
  const model = readFileSync(modelPath, "utf8");
  const m = model.match(/norm_companies as \(([\s\S]*?)\),\s*sheets_clients as \(/);
  if (!m) throw new Error("could not extract norm_companies CTE from identity_resolution.sql");
  return m[1];
};

const sqlNorm = async (rawName: string): Promise<string> => {
  const res = await pool.query(
    `with companies as (
        select 'C-X'::text as canonical_id, $1::text as name, 'x.example.com'::text as domain
     ),
     norm_companies as (${normCompaniesSql()})
     select norm_name from norm_companies`,
    [rawName],
  );
  return res.rows[0].norm_name as string;
};

describe("pinned normalization vectors — SQL side (the real norm_companies text)", () => {
  it.each(NORMALIZATION_VECTORS)(
    "$label: $input → $expected",
    async ({ input, expected }) => {
      expect(await sqlNorm(input)).toBe(expected);
    },
  );
});

describe("pinned normalization vectors — TS side agrees byte-for-byte (the manifest resolver's normalizer; verify-identity makes this pair CI-load-bearing)", () => {
  it.each(NORMALIZATION_VECTORS)(
    "$label: $input → $expected",
    ({ input, expected }) => {
      expect(normalizeCompanyName(input)).toBe(expected);
    },
  );
});

// ── Tier-2 end-to-end per vector: both in-model normalizer copies, functionally ─────────

const RESOLUTION_SQL = loadModel("models/identity/identity_resolution.sql", {
  int_crm__canonical_companies: "tmp_canonical",
  stg_crm__companies: "tmp_stg_companies",
  stg_crm__contacts: "tmp_stg_contacts",
  stg_billing__customers: "tmp_stg_billing",
  stg_support__tickets: "tmp_stg_support",
  stg_sheets__rows: "tmp_stg_sheet_rows",
  free_email_domains: "tmp_free_domains",
});

const createFixtures = async (): Promise<void> => {
  await pool.query(`
    create table tmp_ir_companies (
      company_id text primary key, name text not null, domain text not null,
      canonical_id text not null
    );
    create table tmp_ir_crm_emails (email text not null, company_id text not null);
    create table tmp_support_tickets (
      requester_id text not null, requester_email text, domain text, company_name text
    );
    create table tmp_free_domains (domain text primary key);
    create view tmp_canonical as select company_id, canonical_id from tmp_ir_companies;
    create view tmp_stg_companies as
      select company_id, name, domain, null::text as owner_email from tmp_ir_companies;
    create view tmp_stg_contacts as select email, company_id from tmp_ir_crm_emails;
    create view tmp_stg_billing as
      select null::text as customer_id, null::text as email, null::text as domain,
             null::text as name where false;
    create view tmp_stg_support as
      select requester_id, requester_email, domain, company_name from tmp_support_tickets;
    create view tmp_stg_sheet_rows as
      select null::text as row_key, null::text as client_email, null::text as client_name,
             null::text as company_name, null::bigint as amount_cents, null::text as currency,
             null::text as status, null::text as label, null::text as content_hash,
             null::text as client_key, null::timestamptz as detected_at,
             null::timestamptz as received_at
      where false;
  `);
};

describe("tier-2 end-to-end per vector: RAW company name vs NORMALIZED entity name must match — exercising BOTH in-model normalizer copies (the functional drift pin)", () => {
  beforeEach(createFixtures);

  it.each(NORMALIZATION_VECTORS)(
    "$label: company '$input' tier-2 matches an entity named '$expected'",
    async ({ input, expected }) => {
      await pool.query("insert into tmp_ir_companies values ('C-1', $1, 'acme.example.com', 'C-1')", [input]);
      // The entity carries the already-normal form: it normalizes to itself, so the match
      // succeeds exactly when copy-1(raw) == copy-2(normal) == expected.
      await pool.query(
        "insert into tmp_support_tickets values ('R-1', null, 'acme.example.com', $1)",
        [expected],
      );
      const rows = (await pool.query(RESOLUTION_SQL)).rows.filter(
        (r) => r.source === "support" && r.source_entity_id === "R-1",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].matched_tier).toBe(2);
      expect(rows[0].resolved_entity_id).toBe("C-1");
    },
  );
});

// ── Close F15: the shared EMAIL rule, vector-pinned like the name normalizer ────────────
//
// Tier-1 email joins were byte-exact (support SuppliedEmail, billing email, crm_emails)
// while the sheets arm lower-trimmed — a real-world "John@Acme.example.com" intake
// under-merged to manual review instead of resolving. One rule now, at every evidence
// edge: nullif(lower(trim(email)), '') in SQL, normalizeEmail (lower-trim) in TS.

import { EMAIL_NORMALIZATION_VECTORS, normalizeEmail } from "@switchboard/mock-core";

describe("pinned email vectors — TS side (normalizeEmail, the shared rule's TS half)", () => {
  it.each(EMAIL_NORMALIZATION_VECTORS)("$label: $input → $expected", ({ input, expected }) => {
    expect(normalizeEmail(input)).toBe(expected);
  });
});

describe("tier-1 end-to-end per email vector: a RAW-variant email on EITHER side of the join still resolves tier 1 — both email evidence edges run the shared rule (close F15)", () => {
  beforeEach(createFixtures);

  it.each(EMAIL_NORMALIZATION_VECTORS)(
    "$label: raw variant on the ENTITY side ('$input') tier-1 matches a normal CRM email",
    async ({ input, expected }) => {
      await pool.query("insert into tmp_ir_companies values ('C-1', 'Acme Group', 'acme.example.com', 'C-1')");
      await pool.query("insert into tmp_ir_crm_emails values ($1, 'C-1')", [expected]);
      await pool.query(
        "insert into tmp_support_tickets values ('R-1', $1, 'nowhere.example.com', 'Some Unrelated Name')",
        [input],
      );
      const rows = (await pool.query(RESOLUTION_SQL)).rows.filter(
        (r) => r.source === "support" && r.source_entity_id === "R-1",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].matched_tier).toBe(1);
      expect(rows[0].resolved_entity_id).toBe("C-1");
      // The evidence string carries the NORMALIZED form — auditable, and proof the rule
      // ran at the edge rather than the join getting lucky.
      expect(rows[0].match_evidence).toBe(`email=${expected}`);
    },
  );

  it.each(EMAIL_NORMALIZATION_VECTORS)(
    "$label: raw variant on the CRM side ('$input') tier-1 matches a normal entity email",
    async ({ input, expected }) => {
      await pool.query("insert into tmp_ir_companies values ('C-1', 'Acme Group', 'acme.example.com', 'C-1')");
      await pool.query("insert into tmp_ir_crm_emails values ($1, 'C-1')", [input]);
      await pool.query(
        "insert into tmp_support_tickets values ('R-1', $1, 'nowhere.example.com', 'Some Unrelated Name')",
        [expected],
      );
      const rows = (await pool.query(RESOLUTION_SQL)).rows.filter(
        (r) => r.source === "support" && r.source_entity_id === "R-1",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].matched_tier).toBe(1);
      expect(rows[0].resolved_entity_id).toBe("C-1");
    },
  );
});
