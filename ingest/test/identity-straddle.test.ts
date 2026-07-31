import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { loadModel } from "./helpers/load-model.js";

// ── L2-G3: the multi-tuple straddle, now test-expressible (Task C rider; register HIGH) ──
//
// The register's confirmed repro (2026-07-24, on the post-tier-2-guard SQL): ONE support
// requester whose tickets carry TWO different evidence tuples — different (domain, name)
// pairs, or different emails — where each tuple CLEANLY matches a DIFFERENT canonical
// company. The ambiguity guards group by (source, source_entity_id, <evidence key>), so
// each tuple forms its own clean count=1 group; the entity gets two same-tier rows with
// different canonicals, and the final DISTINCT ON (ordered by matched_tier alone) keeps a
// plan-dependent, silently-arbitrary winner — the exact "silent guess" the guards exist to
// forbid. (A6 fixed this shape for the SHEETS arm only, by collapsing to one candidate
// tuple per client before the tiers; the support/billing arms still straddle.)
//
// These tests assert the HONEST spec: conflicting clean evidence for one entity must not
// silently resolve to an arbitrary canonical. They are written against the REAL
// identity_resolution.sql text (loadModel, refs → fixture views — the merge-resolution
// pattern; no mirror to drift).
//
// STATUS: REPRODUCED — both cases fail against the real SQL, so per the Task C brief this
// thread STOPS here: the pins are recorded with `it.fails` (they pass exactly while the
// defect exists, and will fail loudly the moment a fix lands, forcing their promotion to
// plain `it`). The FIX is a separate decision (NEEDS_CONTEXT in the task report): per-
// entity ambiguity detection across evidence groups, or a deterministic same-tier
// tiebreak plus cross-group demotion — each reshapes guard semantics for every source and
// is not a rider on the tiebreak swap.

let pool: pg.Pool;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ pool, cleanup } = await freshTestDb());
  // Fixture surface mirrors merge-resolution.test.ts: simple tmp tables exposed through
  // views with the staging models' names/columns.
  await pool.query(`
    create table tmp_ir_companies (
      company_id text primary key, name text not null, domain text not null,
      canonical_id text not null
    );
    create table tmp_ir_crm_emails (email text not null, company_id text not null);
    create table tmp_support_tickets (
      requester_id text not null, requester_email text, domain text, company_name text
    );
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
});
afterEach(async () => {
  await cleanup();
});

const RESOLUTION_SQL = loadModel("models/identity/identity_resolution.sql", {
  int_crm__canonical_companies: "tmp_canonical",
  stg_crm__companies: "tmp_stg_companies",
  stg_crm__contacts: "tmp_stg_contacts",
  stg_billing__customers: "tmp_stg_billing",
  stg_support__tickets: "tmp_stg_support",
  stg_sheets__rows: "tmp_stg_sheet_rows",
});

const seedCompanies = async () => {
  await pool.query(`
    insert into tmp_ir_companies values
      ('C-1', 'Acme Logistics', 'acme.example.com', 'C-1'),
      ('C-2', 'Beta Freight',   'beta.example.com', 'C-2');
  `);
};

describe("L2-G3 straddle: one entity, two clean evidence tuples, two canonicals", () => {
  it.fails(
    "tier-2 straddle: a requester whose tickets carry two (domain,name) tuples, each cleanly matching a DIFFERENT canonical, must not silently resolve to an arbitrary one [REPRODUCED — awaiting its own fix decision]",
    async () => {
      await seedCompanies();
      // Requester R-1, no email evidence, two tickets with different clean tuples.
      await pool.query(`
        insert into tmp_support_tickets values
          ('R-1', null, 'acme.example.com', 'Acme Logistics'),
          ('R-1', null, 'beta.example.com', 'Beta Freight');
      `);

      const rows = (await pool.query(RESOLUTION_SQL)).rows.filter(
        (r) => r.source === "support" && r.source_entity_id === "R-1",
      );
      // Exactly one resolution row per entity…
      expect(rows).toHaveLength(1);
      // …and conflicting clean evidence must demote to manual review (tier 3, flagged),
      // mirroring the tier2_ambiguous semantics — never a silent pick of C-1 or C-2.
      expect(rows[0].matched_tier).toBe(3);
      expect(String(rows[0].match_evidence)).toMatch(/ambiguous/);
    },
  );

  it.fails(
    "tier-1 straddle: a requester with DIFFERENT emails across tickets, each cleanly matching a DIFFERENT canonical, bypasses tier1_ambiguous (which groups per email) and resolves arbitrarily [REPRODUCED — awaiting its own fix decision]",
    async () => {
      await seedCompanies();
      await pool.query(`
        insert into tmp_ir_crm_emails values
          ('r@acme.example.com', 'C-1'),
          ('r@beta.example.com', 'C-2');
        insert into tmp_support_tickets values
          ('R-2', 'r@acme.example.com', 'nowhere.example.com', 'Unrelated Name'),
          ('R-2', 'r@beta.example.com', 'elsewhere.example.com', 'Other Name');
      `);

      const rows = (await pool.query(RESOLUTION_SQL)).rows.filter(
        (r) => r.source === "support" && r.source_entity_id === "R-2",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].matched_tier).toBe(3);
      expect(String(rows[0].match_evidence)).toMatch(/ambiguous/);
    },
  );
});
