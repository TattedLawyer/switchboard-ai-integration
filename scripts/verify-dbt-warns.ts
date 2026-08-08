// Post-`dbt build` gate: the warn set must be EXACTLY the pinned green criterion.
//
// dbt exits 0 on warnings, so `dbt build` succeeding says nothing about which — or how
// many — warn-severity tests fired. Since close F7 exactly one is expected to fire
// forever (the demonstration row that keeps the unlikely-value surface from passing
// vacuously). This script makes that criterion mechanical instead of prose:
//
//   1. dbt's own run_results.json artifact → the complete warn SET and per-test row
//      COUNTS (scripts/dbt-warn-contract.ts). Covers every warn-severity test in the
//      project, including ones that don't exist yet, which is the masking half.
//   2. the expected test's own STORED FAILURES table (`store_failures: true` on
//      assert_amounts_plausible) → the row IDENTITY. Read from what the test itself
//      recorded, not re-derived from the models, so the check can't agree with a broken
//      test by making the same mistake twice.
//
// Run in ci.yml immediately after the dbt step. Exits non-zero with every failure named.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  auditSchemaMissingMessage,
  checkWarnSet,
  databaseUrlEndpoint,
  dbtEndpointFromEnv,
} from "./dbt-warn-contract.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_RESULTS = join(ROOT, "warehouse", "target", "run_results.json");

// Identity of the single expected warning row. Seeded by scripts/ci-fixture.ts as the
// first charge.succeeded at plausibleMax + 1; the AMOUNT is derived from the numeric
// contract there (never re-typed), while the id is the mock's — pinned here so a fixture
// that starts flagging some OTHER row reds instead of quietly satisfying the count.
const EXPECTED_WARN_ROW = { kind: "payment", id: "DEMO-CH-0001" };
// dbt's default store_failures location is `{{ profile.schema }}_dbt_test__audit`, and
// warehouse/profiles.yml pins `schema: public` — so this is a literal fact of the repo,
// not config. Singular tests take no `+schema` in dbt_project.yml (only models/seeds do,
// which is why the MODEL schema is public_analytics and this one is not). A literal also
// keeps an unvalidated env var out of SQL identifier position.
const AUDIT_SCHEMA = "public_dbt_test__audit";

async function main() {
  const failures: string[] = [];

  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(RUN_RESULTS, "utf8"));
  } catch (err) {
    console.error(`FAIL: cannot read ${RUN_RESULTS} — run \`dbt build\` first (${String(err)})`);
    process.exit(1);
  }
  failures.push(...checkWarnSet(doc));

  // Row identity, from the test's own recorded failures.
  // PRE-3 (#19): connect the way DBT does, not the way the app does. This table is
  // dbt's own artifact, so the only database it can be read from is the one dbt wrote to.
  const dbtEndpoint = dbtEndpointFromEnv(process.env);
  const pool = new pg.Pool({
    host: dbtEndpoint.host,
    port: dbtEndpoint.port,
    user: dbtEndpoint.user,
    password: dbtEndpoint.password,
    database: dbtEndpoint.database,
  });
  try {
    const rows = await pool.query(
      `select kind, id from ${AUDIT_SCHEMA}.assert_amounts_plausible order by kind, id`,
    );
    const got = rows.rows.map((r: { kind: string; id: string }) => `${r.kind}:${r.id}`);
    const want = [`${EXPECTED_WARN_ROW.kind}:${EXPECTED_WARN_ROW.id}`];
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`assert_amounts_plausible stored failures: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  } catch (err) {
    failures.push(
      auditSchemaMissingMessage({
        auditSchema: AUDIT_SCHEMA,
        dbt: dbtEndpoint,
        appUrl: databaseUrlEndpoint(process.env),
        cause: String(err),
      }),
    );
  } finally {
    await pool.end();
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL: ${f}`);
    console.error(`verify-dbt-warns: ${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log("PASS: dbt warn set is exactly the expected F7 demonstration row (assert_amounts_plausible / DEMO-CH-0001)");
}

main().catch((err) => { console.error(err); process.exit(1); });
