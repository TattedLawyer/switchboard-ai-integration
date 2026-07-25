import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";

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
});
afterEach(async () => {
  await cleanup();
});

// SYNC NOTE: this SQL mirrors warehouse/models/identity/int_crm__canonical_companies.sql
// (ref()s swapped for the tmp_ tables). Keep both in sync — same walk, same guards.
const RESOLUTION_SQL = `
  with recursive walk as (
      select c.company_id, c.company_id as current_id, 0 as merge_depth,
             array[c.company_id] as merge_path, false as is_cycle
      from tmp_companies c
      union all
      select w.company_id, e.to_id, w.merge_depth + 1,
             w.merge_path || e.to_id, e.to_id = any(w.merge_path)
      from walk w
      join tmp_merge_edges e on e.from_id = w.current_id
      where not w.is_cycle and w.merge_depth < 10
  )
  select distinct on (company_id) company_id, current_id as canonical_id, merge_depth, is_cycle
  from walk
  order by company_id, merge_depth desc
`;

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

  // SYNC NOTE: mirrors warehouse/tests/assert_canonical_targets_exist.sql (ref()s swapped
  // for tmp_ tables) — proves the singular test's SQL actually detects the defect, since a
  // dbt test over clean seeded data can't demonstrate its own trigger condition.
  const PHANTOM_CHECK_SQL = `
    select k.company_id, k.canonical_id
    from (${RESOLUTION_SQL}) k
    left join tmp_companies c on c.company_id = k.canonical_id
    where not k.is_cycle and c.company_id is null
  `;

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

// SYNC NOTE: this SQL mirrors the tier CTEs of
// warehouse/models/identity/identity_resolution.sql (ref()s swapped for tmp_ir_* tables;
// the canonical join is pre-flattened into tmp_ir_companies.canonical_id). Keep the
// normalization expressions and tier predicates in sync with the model.
const TIER_SQL = `
  with norm_companies as (
      select
          canonical_id,
          lower(regexp_replace(domain, '^www\\.', '', 'i')) as norm_domain,
          regexp_replace(lower(trim(name)), '\\s+(inc|llc|ltd|corp)\\.?$', '') as norm_name
      from tmp_ir_companies
  ),
  source_entities as (
      select source, source_entity_id, email, domain, name from tmp_ir_entities
  ),
  tier1_candidates as (
      select se.source, se.source_entity_id, se.email, k.canonical_id
      from source_entities se
      join tmp_ir_crm_emails ce on ce.email = se.email
      join tmp_ir_companies k on k.company_id = ce.company_id
  ),
  tier1 as (
      select source, source_entity_id, min(canonical_id) as canonical_id,
             1 as matched_tier, 'email=' || email as match_evidence
      from tier1_candidates
      group by source, source_entity_id, email
      having count(distinct canonical_id) = 1
  ),
  tier1_ambiguous as (
      select source, source_entity_id,
             source || ':' || source_entity_id as canonical_id,
             3 as matched_tier,
             'ambiguous email=' || email || ' matched ' || count(distinct canonical_id) || ' canonical companies' as match_evidence
      from tier1_candidates
      group by source, source_entity_id, email
      having count(distinct canonical_id) > 1
  ),
  tier2_candidates as (
      select se.source, se.source_entity_id, nc.canonical_id, nc.norm_domain, nc.norm_name
      from source_entities se
      join norm_companies nc
        on nc.norm_domain = lower(regexp_replace(se.domain, '^www\\.', '', 'i'))
       and nc.norm_name   = regexp_replace(lower(trim(se.name)), '\\s+(inc|llc|ltd|corp)\\.?$', '')
      where not exists (
          select 1 from tier1 t1
          where t1.source = se.source and t1.source_entity_id = se.source_entity_id
      )
      and not exists (
          select 1 from tier1_ambiguous ta
          where ta.source = se.source and ta.source_entity_id = se.source_entity_id
      )
  ),
  tier2 as (
      select source, source_entity_id, min(canonical_id) as canonical_id,
             2 as matched_tier,
             'domain+name=' || norm_domain || '|' || norm_name as match_evidence
      from tier2_candidates
      group by source, source_entity_id, norm_domain, norm_name
      having count(distinct canonical_id) = 1
  ),
  tier2_ambiguous as (
      select source, source_entity_id,
             source || ':' || source_entity_id as canonical_id,
             3 as matched_tier,
             'ambiguous domain+name=' || norm_domain || '|' || norm_name || ' matched ' || count(distinct canonical_id) || ' canonical companies' as match_evidence
      from tier2_candidates
      group by source, source_entity_id, norm_domain, norm_name
      having count(distinct canonical_id) > 1
  ),
  matched as (
      select * from tier1 union all select * from tier2
      union all select * from tier1_ambiguous union all select * from tier2_ambiguous
  ),
  tier3 as (
      select se.source, se.source_entity_id,
             se.source || ':' || se.source_entity_id as canonical_id,
             3 as matched_tier, 'unmatched' as match_evidence
      from source_entities se
      where not exists (
          select 1 from matched m
          where m.source = se.source and m.source_entity_id = se.source_entity_id
      )
  )
  select distinct on (source, source_entity_id)
      source,
      source_entity_id,
      canonical_id as resolved_entity_id,
      matched_tier,
      match_evidence
  from (select * from matched union all select * from tier3) u
  order by source, source_entity_id, matched_tier
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
