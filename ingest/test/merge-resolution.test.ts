import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { loadModel } from "./helpers/load-model.js";

let pool: pg.Pool;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ pool, cleanup } = await freshTestDb());
  await pool.query(`
    create table tmp_companies (company_id text primary key);
    create table tmp_merge_edges (from_id text primary key, to_id text not null);
    create table tmp_ir_companies (
      company_id text primary key, name text not null, domain text not null,
      canonical_id text not null
    );
    create table tmp_ir_crm_emails (email text not null, company_id text not null);
    create table tmp_ir_entities (
      source text not null, source_entity_id text not null,
      email text not null, domain text not null, name text not null
    );
  `);
  // B2: fixture VIEWS with the staging models' names/columns, so the REAL model text
  // (loaded from disk) runs against the same simple fixtures the old mirrors used.
  await pool.query(`
    create view tmp_canonical as
      select company_id, canonical_id from tmp_ir_companies;
    create view tmp_stg_companies as
      select company_id, name, domain, null::text as owner_email from tmp_ir_companies;
    create view tmp_stg_contacts as
      select email, company_id from tmp_ir_crm_emails;
    create view tmp_stg_billing as
      select source_entity_id as customer_id, email, domain, name
      from tmp_ir_entities where source = 'billing';
    create view tmp_stg_support as
      select source_entity_id as requester_id, email as requester_email, domain,
             name as company_name
      from tmp_ir_entities where source = 'support';
    -- A6 mechanical: identity_resolution gained ref('stg_sheets__rows'); this suite's
    -- concerns (walk, tiers, guards) are sheets-free, so the fixture is an EMPTY view
    -- with the staging column surface. The sheets-arm pins live in
    -- sheet-mart-oracle.test.ts.
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

// B2: the REAL walk model, loaded from disk (refs → tmp_ tables) — no mirror to drift.
const RESOLUTION_SQL = loadModel("models/identity/int_crm__canonical_companies.sql", {
  stg_crm__companies: "tmp_companies",
  merge_edges: "tmp_merge_edges",
});

const seed = async (companies: string[], edges: [string, string][]) => {
  for (const c of companies) await pool.query("insert into tmp_companies values ($1)", [c]);
  for (const [f, t] of edges) await pool.query("insert into tmp_merge_edges values ($1, $2)", [f, t]);
};
const resolve = async () => (await pool.query(RESOLUTION_SQL)).rows;

describe("merge resolution walk", () => {
  it("follows transitive chains to the terminal (A→B→C resolves A to C, depth 2)", async () => {
    await seed(["A", "B", "C"], [["A", "B"], ["B", "C"]]);
    const rows = await resolve();
    expect(rows.find((r) => r.company_id === "A")).toMatchObject({ canonical_id: "C", merge_depth: 2, is_cycle: false });
    expect(rows.find((r) => r.company_id === "B")).toMatchObject({ canonical_id: "C", merge_depth: 1 });
    expect(rows.find((r) => r.company_id === "C")).toMatchObject({ canonical_id: "C", merge_depth: 0 });
  });
  it("flags a 2-cycle (A→B, B→A) as is_cycle and TERMINATES (no hang, no error)", async () => {
    await seed(["A", "B"], [["A", "B"], ["B", "A"]]);
    const rows = await resolve();
    expect(rows.find((r) => r.company_id === "A")!.is_cycle).toBe(true);
    expect(rows.find((r) => r.company_id === "B")!.is_cycle).toBe(true);
  });
  it("flags a self-merge (A→A) as a cycle rather than depth-looping", async () => {
    await seed(["A"], [["A", "A"]]);
    const rows = await resolve();
    expect(rows[0].is_cycle).toBe(true);
  });
  it("depth guard: an 11-link chain surfaces as a non-terminated walk (depth capped at 10)", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `N${i}`);
    const edges = ids.slice(0, 11).map((id, i) => [id, ids[i + 1]] as [string, string]);
    await seed(ids, edges);
    const rows = await resolve();
    const n0 = rows.find((r) => r.company_id === "N0")!;
    expect(n0.merge_depth).toBe(10); // stopped by the guard, NOT at the true terminal N11 —
    // exactly the condition assert_merge_chains_terminate.sql catches in dbt (canonical still
    // has an outgoing edge).
  });

  // B2: the REAL singular test SQL, loaded from disk — proves the dbt test actually
  // detects the defect (a dbt test over clean seeded data can't demonstrate its own
  // trigger condition), with no mirror to drift.
  const PHANTOM_CHECK_SQL = loadModel("tests/assert_canonical_targets_exist.sql", {
    int_crm__canonical_companies: `(${RESOLUTION_SQL})`,
    stg_crm__companies: "tmp_companies",
  });

  it("phantom-canonical detection: a merge event targeting a NONEXISTENT company is caught (L2-G5)", async () => {
    // 'GHOST' has no company record — a company.merged event pointed at a bad id. The walk
    // dutifully resolves A → GHOST, and every deal would roll up to an id no CRM record has.
    await seed(["A"], [["A", "GHOST"]]);
    const rows = (await pool.query(PHANTOM_CHECK_SQL)).rows;
    expect(rows).toEqual([{ company_id: "A", canonical_id: "GHOST" }]);
  });

  it("phantom-canonical detection: a merge to a REAL company raises nothing", async () => {
    await seed(["A", "B"], [["A", "B"]]);
    const rows = (await pool.query(PHANTOM_CHECK_SQL)).rows;
    expect(rows).toEqual([]);
  });
});

// L2-G7: crm_emails must carry LATEST-STATE owner emails only. This suite runs the REAL
// crm_emails CTE text extracted from warehouse/models/identity/identity_resolution.sql (refs
// swapped for the real staging SQL, also read from disk) against a raw fixture — no mirror to
// drift: if the model regresses to scanning raw history, this fails.
describe("crm_emails latest-state (L2-G7)", () => {
  const modelsDir = join(dirname(fileURLToPath(import.meta.url)), "../../warehouse/models");
  const readModel = (rel: string) => readFileSync(join(modelsDir, rel), "utf8");

  const crmEmailsSql = (): string => {
    const model = readModel("identity/identity_resolution.sql");
    const m = model.match(/crm_emails as \(([\s\S]*?)\),\s*norm_companies as \(/);
    if (!m) throw new Error("could not extract crm_emails CTE from identity_resolution.sql");
    const body = m[1]
      .replaceAll("{{ ref('stg_crm__contacts') }}", "stg_crm__contacts")
      .replaceAll("{{ ref('stg_crm__companies') }}", "stg_crm__companies");
    // The staging files are complete SELECT statements (with their own WITH clauses) — legal as
    // CTE bodies in Postgres — reading raw.raw_events, which freshTestDb provides.
    return `
      with stg_crm__contacts as (${readModel("staging/stg_crm__contacts.sql")}),
           stg_crm__companies as (${readModel("staging/stg_crm__companies.sql")}),
           crm_emails as (${body})
      select email, company_id from crm_emails order by email
    `;
  };

  const insertCrmRaw = async (eventId: string, eventType: string, occurredAt: string, data: Record<string, unknown>) => {
    await pool.query(
      `insert into raw.raw_events (source, event_id, event_type, payload)
       values ('crm', $1, $2, $3::jsonb)`,
      [eventId, eventType, JSON.stringify({ occurred_at: occurredAt, data })],
    );
  };

  it("a REPLACED owner_email stops being identity evidence: only the latest-state owner_email survives, even when the stale update arrives late", async () => {
    const company = { id: "c-own-1", name: "Owner Test Co", domain: "own.example.com" };
    // TRUE latest state (newer occurred_at) delivered FIRST...
    await insertCrmRaw("evt-20", "company.updated", "2026-07-22T10:00:00.000Z", {
      ...company, owner_email: "owner.new@example.com",
    });
    // ...then the STALE state (older occurred_at, the replaced owner) arrives LATE.
    await insertCrmRaw("evt-21", "company.updated", "2026-07-21T10:00:00.000Z", {
      ...company, owner_email: "owner.old@example.com",
    });
    // Contact emails ride along untouched (the other UNION arm).
    await insertCrmRaw("evt-22", "contact.updated", "2026-07-22T10:00:00.000Z", {
      id: "ct-1", company_id: "c-own-1", name: "Jane", email: "jane@own.example.com",
    });

    const rows = (await pool.query(crmEmailsSql())).rows;
    // The replaced owner.old@ must be GONE — under the old raw-history scan it stayed tier-1
    // evidence forever. owner.new@ and the contact email are the complete evidence set.
    expect(rows).toEqual([
      { email: "jane@own.example.com", company_id: "c-own-1" },
      { email: "owner.new@example.com", company_id: "c-own-1" },
    ]);
  });

  it("a company whose latest state has NO owner_email contributes no owner row (null is filtered, not matched)", async () => {
    await insertCrmRaw("evt-23", "company.updated", "2026-07-22T10:00:00.000Z", {
      id: "c-own-2", name: "No Owner Co", domain: "noown.example.com",
    });
    const rows = (await pool.query(crmEmailsSql())).rows;
    expect(rows).toEqual([]);
  });
});

// B2: the REAL identity_resolution.sql, loaded from disk (refs -> the fixture views
// created in beforeEach) -- no mirror to drift, and no pre-flattening: the model's own
// crm_emails UNION and source_entities arms run as written, so structural bugs the old
// flattened mirror could not express (e.g. the L2-G3 multi-tuple straddle) are now
// testable here. The wrapper projects the mirror-era column set so assertions stay put.
const TIER_SQL = `
  select source, source_entity_id, resolved_entity_id, matched_tier, match_evidence
  from (${loadModel("models/identity/identity_resolution.sql", {
    int_crm__canonical_companies: "tmp_canonical",
    stg_crm__companies: "tmp_stg_companies",
    stg_crm__contacts: "tmp_stg_contacts",
    stg_billing__customers: "tmp_stg_billing",
    stg_support__tickets: "tmp_stg_support",
    stg_sheets__rows: "tmp_stg_sheet_rows",
  })}) m
`;

const seedTiers = async (opts: {
  companies: [id: string, name: string, domain: string, canonicalId: string][];
  crmEmails: [email: string, companyId: string][];
  entities: [source: string, id: string, email: string, domain: string, name: string][];
}) => {
  for (const c of opts.companies)
    await pool.query("insert into tmp_ir_companies values ($1, $2, $3, $4)", c);
  for (const e of opts.crmEmails)
    await pool.query("insert into tmp_ir_crm_emails values ($1, $2)", e);
  for (const e of opts.entities)
    await pool.query("insert into tmp_ir_entities values ($1, $2, $3, $4, $5)", e);
};
const resolveTiers = async () => (await pool.query(TIER_SQL)).rows;

describe("three-tier identity resolution", () => {
  it("tier 1: exact contact-email match resolves to the contact company's CANONICAL id (merge lineage applied)", async () => {
    await seedTiers({
      // C-B was merged into C-A: canonical of C-B is C-A.
      companies: [
        ["C-A", "Acme Group", "acme.example.com", "C-A"],
        ["C-B", "Acme Group Inc", "acme.example.com", "C-A"],
      ],
      crmEmails: [["jane@acme.example.com", "C-B"]],
      entities: [["billing", "B-1", "jane@acme.example.com", "unrelated.example.com", "Some Other Name"]],
    });
    const rows = await resolveTiers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "billing",
      source_entity_id: "B-1",
      resolved_entity_id: "C-A",
      matched_tier: 1,
      match_evidence: "email=jane@acme.example.com",
    });
  });
  it("tier 2 near-miss (domain matches, name does NOT) must fall through to tier 3 manual review — never tier 1 or 2", async () => {
    await seedTiers({
      companies: [["C-A", "Acme Group", "acme.example.com", "C-A"]],
      crmEmails: [["jane@acme.example.com", "C-A"]],
      entities: [["support", "S-1", "help@nowhere.example.com", "acme.example.com", "Totally Different Name"]],
    });
    const rows = await resolveTiers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "support",
      source_entity_id: "S-1",
      resolved_entity_id: "support:S-1",
      matched_tier: 3,
      match_evidence: "unmatched",
    });
  });
  it("tier 2: normalization (case, leading www., trailing Inc/LLC±period) matches domain AND name", async () => {
    await seedTiers({
      companies: [["C-A", "Acme Group", "acme.example.com", "C-A"]],
      crmEmails: [],
      entities: [["billing", "B-2", "billing@elsewhere.example.com", "WWW.Acme.example.com", "ACME GROUP Inc."]],
    });
    const rows = await resolveTiers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resolved_entity_id: "C-A",
      matched_tier: 2,
      match_evidence: "domain+name=acme.example.com|acme group",
    });
  });
  it("over-merge guard: an email mapped to TWO distinct canonical companies must NOT tier-1 resolve — it lands in tier 3 (manual review), never a nondeterministic winner", async () => {
    await seedTiers({
      companies: [
        ["C-A", "Acme Group", "acme.example.com", "C-A"],
        ["C-Z", "Zenith Corp", "zenith.example.com", "C-Z"],
      ],
      // Shared/freemail-style address registered as a contact at BOTH companies:
      crmEmails: [
        ["ops@sharedagency.example.com", "C-A"],
        ["ops@sharedagency.example.com", "C-Z"],
      ],
      entities: [["billing", "B-4", "ops@sharedagency.example.com", "unrelated.example.com", "Some Other Name"]],
    });
    const rows = await resolveTiers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "billing",
      source_entity_id: "B-4",
      resolved_entity_id: "billing:B-4",
      matched_tier: 3,
    });
    expect(rows[0].match_evidence).toContain("ambiguous");
  });
  it("over-merge guard does NOT fire when two company records share an email but collapse to ONE canonical (merge lineage)", async () => {
    await seedTiers({
      // C-B merged into C-A: same email at both records is still ONE canonical entity.
      companies: [
        ["C-A", "Acme Group", "acme.example.com", "C-A"],
        ["C-B", "Acme Group Inc", "acme.example.com", "C-A"],
      ],
      crmEmails: [
        ["jane@acme.example.com", "C-A"],
        ["jane@acme.example.com", "C-B"],
      ],
      entities: [["billing", "B-5", "jane@acme.example.com", "unrelated.example.com", "Other"]],
    });
    const rows = await resolveTiers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resolved_entity_id: "C-A", matched_tier: 1 });
  });
  it("ambiguous tier-1 email is NOT rescued by tier 2 — conflicting email evidence forces manual review even when domain+name would match", async () => {
    await seedTiers({
      companies: [
        ["C-A", "Acme Group", "acme.example.com", "C-A"],
        ["C-Z", "Zenith Corp", "zenith.example.com", "C-Z"],
      ],
      crmEmails: [
        ["ops@sharedagency.example.com", "C-A"],
        ["ops@sharedagency.example.com", "C-Z"],
      ],
      // domain+name would tier-2 match C-A, but the ambiguous email makes ANY merge suspect:
      entities: [["billing", "B-6", "ops@sharedagency.example.com", "acme.example.com", "Acme Group"]],
    });
    const rows = await resolveTiers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resolved_entity_id: "billing:B-6", matched_tier: 3 });
  });
  it("tier-2 over-merge guard: domain+name matching TWO distinct UNMERGED canonicals must NOT tier-2 resolve — it lands in tier 3 (manual review), never an arbitrary winner", async () => {
    await seedTiers({
      // Same normalized domain AND same normalized name ("acme group"), but NOT merged:
      // two distinct canonical companies. Any tier-2 pick would be a silent false merge.
      companies: [
        ["C-A", "Acme Group", "acme.example.com", "C-A"],
        ["C-Z", "Acme Group Inc", "acme.example.com", "C-Z"],
      ],
      crmEmails: [],
      entities: [["billing", "B-1", "billing@nowhere.example.com", "acme.example.com", "ACME GROUP LLC"]],
    });
    const rows = await resolveTiers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "billing",
      source_entity_id: "B-1",
      resolved_entity_id: "billing:B-1",
      matched_tier: 3,
    });
    expect(rows[0].match_evidence).toContain("ambiguous");
  });
  it("tier-2 over-merge guard does NOT fire when the domain+name candidates collapse to ONE canonical (merge lineage) — a MERGED pair still tier-2 resolves", async () => {
    await seedTiers({
      // C-B merged into C-A: both records share domain + normalized name, but they are
      // ONE canonical entity — the guard must not block this legitimate resolution.
      companies: [
        ["C-A", "Acme Group", "acme.example.com", "C-A"],
        ["C-B", "Acme Group Inc", "acme.example.com", "C-A"],
      ],
      crmEmails: [],
      entities: [["billing", "B-7", "billing@nowhere.example.com", "acme.example.com", "Acme Group"]],
    });
    const rows = await resolveTiers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resolved_entity_id: "C-A",
      matched_tier: 2,
      match_evidence: "domain+name=acme.example.com|acme group",
    });
  });
  it("tier precedence: an entity matching BOTH tier 1 and tier 2 resolves once, as tier 1", async () => {
    await seedTiers({
      companies: [["C-A", "Acme Group", "acme.example.com", "C-A"]],
      crmEmails: [["jane@acme.example.com", "C-A"]],
      entities: [["billing", "B-3", "jane@acme.example.com", "acme.example.com", "Acme Group"]],
    });
    const rows = await resolveTiers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resolved_entity_id: "C-A", matched_tier: 1 });
  });
});
