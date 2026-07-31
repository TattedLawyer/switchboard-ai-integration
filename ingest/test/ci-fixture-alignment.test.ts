// C1 (cold review A6–A7): the CI fixture must seed ONE correlated universe.
//
// The fixture's CRM leg ingests only the scripted feed's contacts (108 events → 26
// distinct contact emails), while the sheets leg's row source draws from the FULL
// manifest contact pool. Any sheet client whose email the CRM leg never ingested has no
// tier-1 evidence, lands tier-3 (correctly — identity_resolution's sheets arm is not the
// defect), flows into manual_review and customer_360, and scripts/verify-identity.ts —
// which pins the tier-3 universe to billing+support — fails checks 4 and 5b on the next
// CI push. The fixture is a FAULTLESS fixture by design: tier-3 sheets orphans belong to
// the fault-plan oracles (sheet-mart-oracle.test.ts), not the CI gate.
//
// This test pins the alignment invariant STRUCTURALLY against the real script: it runs
// scripts/ci-fixture.ts as a child process (the exact surface ci.yml runs) against an
// ephemeral database and asserts every sheets-leg client email is drawn from the set of
// contact emails the CRM leg actually ingested — over ALL sheet.row_upserted events, not
// just latest state, so a misaligned email that was later tombstoned still fails loudly.
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshTestDb, type TestDbResult } from "./helpers/testdb.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
// The fixture provisions four in-process servers, pushes 288 ledger events, and runs
// five connector cycles — well beyond the config's 30s under contention.
const FIXTURE_TIMEOUT = 120_000;

let db: TestDbResult;
let run: { code: number; stdout: string; stderr: string };

/** Runs the REAL scripts/ci-fixture.ts as a child process — the exact ci.yml step.
 *  cwd is the repo root (like CI), so out/ci lands in the gitignored out/ tree.
 *  Non-zero exit is a result here, not a spawn error. */
function runCiFixture(dbUrl: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "scripts/ci-fixture.ts"],
      {
        cwd: ROOT,
        timeout: FIXTURE_TIMEOUT,
        env: { ...process.env, DATABASE_URL: dbUrl, ALLOW_DEV_SECRETS: "1" },
      },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== "number") return reject(err);
        resolve({ code: err ? (err.code as number) : 0, stdout, stderr });
      },
    );
  });
}

beforeAll(async () => {
  db = await freshTestDb();
  run = await runCiFixture(db.url);
}, FIXTURE_TIMEOUT + 30_000);

afterAll(async () => {
  await db.cleanup();
});

describe("ci-fixture correlated universe (cold review C1)", () => {
  it("the fixture itself exits 0 with its pinned per-source counts", () => {
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("PASS: ci fixture seeded");
  });

  it(
    "alignment invariant: every sheets-leg client email is a contact email the CRM leg actually ingested (⊆, over all upserts) — no tier-3 sheets orphans in the CI gate's universe",
    async () => {
      const sheetEmails = await db.pool.query(`
        select distinct payload -> 'data' ->> 'email' as email
        from raw.raw_events
        where source = 'sheets' and event_type = 'sheet.row_upserted'
          and nullif(trim(payload -> 'data' ->> 'email'), '') is not null
        order by email
      `);
      const crmEmails = await db.pool.query(`
        select distinct payload -> 'data' ->> 'email' as email
        from raw.raw_events
        where source = 'crm' and event_type = 'contact.updated'
      `);
      // Guard against a vacuous pass: both legs must actually have seeded emails.
      expect(sheetEmails.rows.length).toBeGreaterThan(0);
      expect(crmEmails.rows.length).toBeGreaterThan(0);

      const ingested = new Set(crmEmails.rows.map((r) => r.email as string));
      const orphans = sheetEmails.rows
        .map((r) => r.email as string)
        .filter((e) => !ingested.has(e));
      // Exact-string comparison is deliberate: manifest emails are lowercase, and the
      // tier-1 join's CRM side compares raw strings (the normalization asymmetry is a
      // registered Task F item, not this test's to hide).
      expect(orphans).toEqual([]);
    },
    FIXTURE_TIMEOUT,
  );

  it("the sheets leg's raw event count stays pinned (a silently short or inflated run must fail loudly)", async () => {
    const n = await db.pool.query(
      `select count(*)::int as n from raw.raw_events where source = 'sheets'`,
    );
    expect(n.rows[0].n).toBe(22);
  });
});
