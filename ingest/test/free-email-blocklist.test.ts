import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { loadModel } from "./helpers/load-model.js";

// ── Task F: the free-email blocklist — the register's before-tier-2-on-real-data gate ───
//
// Research record (full primary-source reads, 2026-08-01, cited in the Task F report):
// HubSpot's own company-matching documentation is explicit that freemail domains carry
// no company-identity signal — "If the contact has a freemail value in the Email
// property (e.g., gmail.com, yahoo.com), HubSpot will also look at the contact's
// Website URL property" instead of matching the freemail domain to a company
// (knowledge.hubspot.com/object-settings/automatically-create-and-associate-companies-
// with-contacts); its forms product ships a maintained blocked-domain list for the same
// providers (knowledge.hubspot.com/forms/what-domains-are-blocked-when-using-the-forms-
// email-domains-to-block-feature). The open-source ecosystem maintains vendorable
// exhaustive lists (github.com/Kikobeats/free-email-domains, github.com/willwhite/
// freemail — the latter split free vs disposable, which are different categories).
//
// The semantics here (per the phase plan Task F): a tier-2 match whose domain evidence
// is a free provider DEMOTES TO MANUAL REVIEW with a named reason — never a silent
// tier-2 resolve (the pre-blocklist behavior: every duplicate common name on gmail
// merged into the first company sharing it, unflagged) and never a silent drop of the
// fact that a name+domain DID match. Free-provider evidence is NO-SIGNAL evidence: it
// neither resolves nor conflicts, so an entity that ALSO carries corporate-domain
// evidence resolves on that evidence alone. Exact-address tier-1 evidence is untouched:
// a specific mailbox is identity evidence regardless of its provider — only the DOMAIN
// half of domain+name is meaningless on a free provider.
//
// The list itself is a dbt seed (warehouse/seeds/free_email_domains.csv): curated major
// providers, documented as curated-not-exhaustive with the vendored-list upgrade path.
// These tests run the REAL model text (loadModel; ref('free_email_domains') → fixture
// table), so the tests pin the mechanism against any list content.

let pool: pg.Pool;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ pool, cleanup } = await freshTestDb());
  await pool.query(`
    create table tmp_ir_companies (
      company_id text primary key, name text not null, domain text not null,
      canonical_id text not null
    );
    create table tmp_ir_crm_emails (email text not null, company_id text not null);
    create table tmp_support_tickets (
      requester_id text not null, requester_email text, domain text, company_name text
    );
    create table tmp_sheet_rows (
      row_key text primary key, client_email text, client_name text, company_name text,
      amount_cents bigint, currency text, status text, label text, content_hash text,
      client_key text not null, detected_at timestamptz not null, received_at timestamptz not null
    );
    create table tmp_free_domains (domain text primary key);
    insert into tmp_free_domains values ('gmail.com'), ('yahoo.com'), ('outlook.com');
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
      select row_key, client_email, client_name, company_name, amount_cents, currency,
             status, label, content_hash, client_key, detected_at, received_at
      from tmp_sheet_rows;
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
  free_email_domains: "tmp_free_domains",
});

const resolve = async (source: string, id: string) =>
  (await pool.query(RESOLUTION_SQL)).rows.filter(
    (r) => r.source === source && r.source_entity_id === id,
  );

describe("free-email blocklist: tier-2 matches on free-provider domains demote to manual review", () => {
  it("a support requester on gmail.com whose name matches a gmail-domiciled company lands in MANUAL REVIEW with the provider named — never a silent tier-2 merge of two unrelated gmail businesses", async () => {
    // The gmail-heavy SMB scenario from KNOWN-ISSUES: an SMB whose CRM record uses its
    // gmail address as its domain, and a DIFFERENT business with the same common name.
    await pool.query(`
      insert into tmp_ir_companies values ('C-1', 'Smith Plumbing', 'gmail.com', 'C-1');
      insert into tmp_support_tickets values
        ('R-1', 'smithplumbing2@gmail.com', 'gmail.com', 'Smith Plumbing LLC');
    `);
    const rows = await resolve("support", "R-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].matched_tier).toBe(3);
    expect(String(rows[0].match_evidence)).toMatch(/free-email domain=gmail\.com/);
    expect(String(rows[0].match_evidence)).toMatch(/manual review/);
    // The demotion names its own cause, not the generic ones (checklist line 5).
    expect(String(rows[0].match_evidence)).not.toMatch(/^unmatched$/);
    expect(String(rows[0].match_evidence)).not.toMatch(/ambiguous/);
  });

  it("C2 companion — the sheets arm inherits the gate: a sheet client's ORPHAN-DERIVED gmail domain (split from its own email) must not tier-2 resolve; it demotes with the provider named", async () => {
    await pool.query(`
      insert into tmp_ir_companies values ('C-1', 'Smith Plumbing', 'gmail.com', 'C-1');
      insert into tmp_sheet_rows values
        ('rk-1', 'smithplumbing2@gmail.com', 'Sam Smith', 'Smith Plumbing LLC',
         1000, 'USD', 'open', 'row', 'hash-1', 'email:smithplumbing2@gmail.com',
         '2026-07-28T10:00:00Z', '2026-07-28T10:00:00Z');
    `);
    const rows = await resolve("sheets", "email:smithplumbing2@gmail.com");
    expect(rows).toHaveLength(1);
    expect(rows[0].matched_tier).toBe(3);
    expect(String(rows[0].match_evidence)).toMatch(/free-email domain=gmail\.com/);
    expect(String(rows[0].match_evidence)).toMatch(/manual review/);
  });

  it("corporate-domain tier-2 matching is untouched beside the blocklist — the boundary pin", async () => {
    await pool.query(`
      insert into tmp_ir_companies values ('C-1', 'Acme Group', 'acme.example.com', 'C-1');
      insert into tmp_support_tickets values
        ('R-2', null, 'acme.example.com', 'Acme Group Inc');
    `);
    const rows = await resolve("support", "R-2");
    expect(rows).toHaveLength(1);
    expect(rows[0].matched_tier).toBe(2);
    expect(rows[0].resolved_entity_id).toBe("C-1");
  });

  it("free-provider evidence is NO-SIGNAL, not counter-evidence: an entity carrying BOTH a corporate-domain match and a free-domain match resolves on the corporate evidence alone", async () => {
    await pool.query(`
      insert into tmp_ir_companies values
        ('C-1', 'Acme Group',     'acme.example.com', 'C-1'),
        ('C-2', 'Smith Plumbing', 'gmail.com',        'C-2');
      insert into tmp_support_tickets values
        ('R-3', null, 'acme.example.com', 'Acme Group'),
        ('R-3', null, 'gmail.com',        'Smith Plumbing');
    `);
    const rows = await resolve("support", "R-3");
    expect(rows).toHaveLength(1);
    expect(rows[0].matched_tier).toBe(2);
    expect(rows[0].resolved_entity_id).toBe("C-1");
    expect(String(rows[0].match_evidence)).not.toMatch(/ambiguous|free-email/);
  });

  it("tier-1 exact-address evidence is untouched by the blocklist: a specific gmail MAILBOX that is CRM contact evidence still resolves at tier 1 — only the domain half is meaningless, never the address", async () => {
    await pool.query(`
      insert into tmp_ir_companies values ('C-1', 'Acme Group', 'acme.example.com', 'C-1');
      insert into tmp_ir_crm_emails values ('owner.acme@gmail.com', 'C-1');
      insert into tmp_support_tickets values
        ('R-4', 'owner.acme@gmail.com', 'gmail.com', 'Unrelated Words');
    `);
    const rows = await resolve("support", "R-4");
    expect(rows).toHaveLength(1);
    expect(rows[0].matched_tier).toBe(1);
    expect(rows[0].resolved_entity_id).toBe("C-1");
  });
});
