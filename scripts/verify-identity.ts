// Identity-correctness oracle: asserts the dbt identity layer + customer_360 mart match the
// seeded manifest's machine-checkable expectations (tier partition, manual_review membership,
// merge collapse, deal conservation, D6 incomplete flags, cross-system joins).
// Run after dbt build in demo.sh (and CI). Relative import of mock code uses the same
// exemption ingest tests use (script/test code, not shipped src).
import pg from "pg";
import { generateManifest } from "../mocks/core/src/manifest.js";

const SCHEMA = process.env.DBT_SCHEMA ?? "public_analytics";
const m = generateManifest();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let failures = 0;
const fail = (msg: string) => { failures++; console.error(`FAIL: ${msg}`); };
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

async function main() {
  // 1. Merge collapse: 22 staged companies → 20 canonical entities; merged ids absent from the mart.
  const canon = await pool.query(`select count(distinct canonical_id)::int as n from ${SCHEMA}.int_crm__canonical_companies where not is_cycle`);
  if (canon.rows[0].n !== m.expectations.canonicalCompanyCount)
    fail(`canonical companies: expected ${m.expectations.canonicalCompanyCount}, got ${canon.rows[0].n}`);
  for (const p of m.expectations.mergePairs) {
    const gone = await pool.query(`select 1 from ${SCHEMA}.customer_360 where entity_id = $1`, [p.from_id]);
    if (gone.rowCount !== 0) fail(`merged-away ${p.from_id} still has a mart row`);
    const there = await pool.query(`select 1 from ${SCHEMA}.customer_360 where entity_id = $1`, [p.to_id]);
    if (there.rowCount !== 1) fail(`canonical ${p.to_id} missing from mart`);
  }
  // 2. Re-pointed history: no open deal is lost to the collapse (conservation across the mapping).
  const stagedOpen = await pool.query(`select count(*)::int as n from ${SCHEMA}.stg_crm__deals where status = 'open'`);
  const martOpen = await pool.query(`select coalesce(sum(open_deal_count), 0)::int as n from ${SCHEMA}.customer_360`);
  if (stagedOpen.rows[0].n !== martOpen.rows[0].n)
    fail(`open-deal conservation: staging ${stagedOpen.rows[0].n} != mart ${martOpen.rows[0].n}`);
  // 3. Tier assignments match the planned matrix exactly (per source).
  for (const source of ["billing", "support"] as const) {
    for (const [tier, expected] of [[1, m.expectations.tier1[source]], [2, m.expectations.tier2[source]], [3, m.expectations.manualReview[source]]] as const) {
      const got = await pool.query(
        `select source_entity_id as id from ${SCHEMA}.identity_resolution where source = $1 and matched_tier = $2`,
        [source, tier],
      );
      const gotIds = ids(got.rows); const want = [...expected].sort();
      if (JSON.stringify(gotIds) !== JSON.stringify(want))
        fail(`${source} tier ${tier}: expected ${JSON.stringify(want)}, got ${JSON.stringify(gotIds)}`);
    }
  }
  // 4. manual_review holds exactly the planned tier-3 population.
  const mr = await pool.query(`select source_entity_id as id from ${SCHEMA}.manual_review`);
  const wantMr = [...m.expectations.manualReview.billing, ...m.expectations.manualReview.support].sort();
  if (JSON.stringify(ids(mr.rows)) !== JSON.stringify(wantMr))
    fail(`manual_review: expected ${JSON.stringify(wantMr)}, got ${JSON.stringify(ids(mr.rows))}`);
  // 5. D6: EVERY unmatchable (tier-3) entity — billing AND support — appears in the mart,
  // flagged incomplete. Full manual_review membership, no sampling: a tier-3 entity that
  // silently vanishes from the mart must fail here.
  for (const source of ["billing", "support"] as const) {
    for (const id of m.expectations.manualReview[source]) {
      const row = await pool.query(`select is_complete from ${SCHEMA}.customer_360 where entity_id = $1`, [`${source}:${id}`]);
      if (row.rowCount !== 1) { fail(`incomplete entity ${source}:${id} missing from mart`); continue; }
      if (row.rows[0].is_complete !== false) fail(`${source}:${id} should be flagged incomplete`);
    }
  }
  // 5b. Total-row-count conservation: one mart row per canonical company plus one per tier-3
  // entity, exactly. Closes the remaining vanish gap — a CRM-only canonical (no merge pair,
  // no billing/support link, e.g. C-0017..C-0020) dropped from the mart is invisible to
  // checks 1–5 but shifts this count.
  const expectedTotal = m.expectations.canonicalCompanyCount
    + m.expectations.manualReview.billing.length + m.expectations.manualReview.support.length;
  const total = await pool.query(`select count(*)::int as n from ${SCHEMA}.customer_360`);
  if (total.rows[0].n !== expectedTotal)
    fail(`customer_360 total rowcount: expected ${expectedTotal} (${m.expectations.canonicalCompanyCount} canonical + ${expectedTotal - m.expectations.canonicalCompanyCount} manual_review), got ${total.rows[0].n}`);
  // 6. Cross-system entities carry data from all three sources.
  for (const id of m.expectations.crossSystemCompanyIds) {
    const row = await pool.query(`select has_crm, has_billing, has_support from ${SCHEMA}.customer_360 where entity_id = $1`, [id]);
    if (row.rowCount !== 1 || !(row.rows[0].has_crm && row.rows[0].has_billing && row.rows[0].has_support))
      fail(`${id} should be present in all three systems`);
  }
  await pool.end();
  if (failures > 0) { console.error(`verify-identity: ${failures} failure(s)`); process.exit(1); }
  console.log("PASS: identity resolution matches the seeded manifest expectations");
}
main().catch((err) => { console.error(err); process.exit(1); });
