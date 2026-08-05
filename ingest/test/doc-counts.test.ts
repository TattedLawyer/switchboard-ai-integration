// Gate-H C1 / I1 — the scoreboard and the README's test count, as DERIVED numbers.
//
// The lie this pins out: KNOWN-ISSUES.md published "20 open defects" with a
// hand-counting method ("Part II holds 24 top-level bullets, four of which are the
// paid sub-items … 24 − 4 = 20"). Twelve bullets were added in one commit without a
// recount, so the register whose entire job is to keep the headline honest was itself
// understating open defects by ~55% — falsifiable with one `awk`, on the first table a
// stranger reads. A hand recount would have gone stale again on the next commit; it
// went stale in days the first time. So the numbers are derived from the file here and
// the derivation is the thing under test.
//
// Operator-surface checklist line 7, applied to a doc rather than a CLI: the load-bearing
// sentences are quoted inside the pin, so the edit that falsifies one reds a test whose
// failure message points at the doc.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  README_TEST_COUNT_CLAIMS,
  deriveRegisterCounts,
  readScoreboard,
  readmeTestCounts,
  sumSuiteLog,
  readDbtTotals,
  RUN_RESULTS_SCHEMA,
  countFastCheckProperties,
  countSuiteWorkspaces,
  readmePropertyClaim,
  readmeWorkspaceClaim,
  readDbtClaims,
  dbtClaimFailures,
} from "../../scripts/doc-counts.js";

const repoFile = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const knownIssues = repoFile("KNOWN-ISSUES.md");
const readme = repoFile("README.md");

describe("KNOWN-ISSUES scoreboard is derived from the file, not counted by hand", () => {
  it("every published count matches the derivation the file itself states", () => {
    const derived = deriveRegisterCounts(knownIssues);
    const published = readScoreboard(knownIssues);
    expect(published, "the scoreboard table could not be parsed out of KNOWN-ISSUES.md").not.toBeNull();
    expect(published).toEqual({
      openDefects: derived.openDefects,
      designDisclosures: derived.designDisclosures,
      paid: derived.paid,
    });
  });

  it("Part II's own rule holds: every open entry names an owner", () => {
    // The rule is stated at the head of Part II ("Every entry names an **owner**").
    // Before this pin, four Security-posture entries named none — which is also what
    // made the count underivable, because "names an owner" is exactly what separates an
    // open defect from the paid sub-items kept in place for readability.
    const derived = deriveRegisterCounts(knownIssues);
    expect(
      derived.partIIOwnerless,
      `Part II entries with no "Owner:" line: ${JSON.stringify(derived.partIIOwnerless, null, 2)}`,
    ).toEqual([]);
  });

  it("the scoreboard states the method it can actually be reapplied with", () => {
    // The old provenance line named commit f4c2c0f, which predates the three-part
    // restructure entirely: `git show f4c2c0f:KNOWN-ISSUES.md | grep -c "Part II"` → 0.
    // A method nobody can rerun is not a method.
    expect(knownIssues).toContain("scripts/doc-counts.ts");
    expect(knownIssues).not.toContain("Counted by hand");
  });
});

describe("README's test-count claims", () => {
  it("states one number, not three that can drift apart", () => {
    const counts = readmeTestCounts(readme);
    expect(counts.length, "expected README to carry test-count claims").toBe(README_TEST_COUNT_CLAIMS);
    expect(new Set(counts).size, `README test counts disagree with each other: ${counts.join(", ")}`).toBe(1);
  });

  it("pins the count to a mechanical check rather than leaving it a bare present-tense claim", () => {
    // The suite total cannot be measured from inside the suite, so the check lives in
    // scripts/verify-doc-counts.ts and runs in CI against the real `npm test` log.
    // What IS checkable here is that README says where its number comes from.
    expect(readme).toContain("scripts/verify-doc-counts.ts");
  });
});

describe("sumSuiteLog reads the log CI actually produces", () => {
  // The gate went green locally and red in CI on 1ae95ea with "no \"Tests N passed\"
  // lines — this is not a full npm test log". The lines were there. Vitest colorizes
  // when it thinks it has a TTY-ish reporter, so CI's raw bytes were
  // `Tests \x1b[22m \x1b[1m\x1b[32m59 passed\x1b[39m…` and the pattern could not span
  // the escape sequences. A verifier that only parses ONE of the two shapes its input
  // comes in is not a gate; it is a coin flip on an environment detail.
  //
  // Fixed by stripping ANSI before matching rather than by forcing NO_COLOR in the
  // workflow: the workflow fix leaves the parser fragile for anyone who pipes a
  // colorized log into it, which is the ordinary way a human reproduces a CI failure.
  const plain = [
    " Test Files  6 passed (6)",
    "      Tests  59 passed (59)",
    "   Start at  09:14:02",
    " Test Files  41 passed (41)",
    "      Tests  1 failed | 677 passed (678)",
  ].join("\n");

  // The same two summaries as vitest actually emits them with colour on, transcribed
  // from the CI log of run 1ae95ea. `\x1b` rather than a raw 0x1b byte only so the
  // sample stays visible in a diff — it is the same string at runtime. Transcribed
  // rather than generated from the parser's own notion of an escape, so the sample
  // cannot drift into agreeing with the parser by construction.
  const colorized = [
    " \x1b[2mTest Files\x1b[22m  \x1b[1m\x1b[32m6 passed\x1b[39m\x1b[22m\x1b[90m (6)\x1b[39m",
    "      \x1b[2mTests\x1b[22m  \x1b[1m\x1b[32m59 passed\x1b[39m\x1b[22m\x1b[90m (59)\x1b[39m",
    "   \x1b[2mStart at\x1b[22m  09:14:02",
    " \x1b[2mTest Files\x1b[22m  \x1b[1m\x1b[32m41 passed\x1b[39m\x1b[22m\x1b[90m (41)\x1b[39m",
    "      \x1b[2mTests\x1b[22m  \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[90m | \x1b[39m\x1b[1m\x1b[32m677 passed\x1b[39m\x1b[22m\x1b[90m (678)\x1b[39m",
  ].join("\n");

  it("sums a plain (non-TTY) log", () => {
    expect(sumSuiteLog(plain)).toBe(59 + 1 + 677);
  });

  it("sums a colorized log to the SAME total — colour is not information", () => {
    expect(sumSuiteLog(colorized)).toBe(sumSuiteLog(plain));
  });

  it("still fails closed on a log with no count lines at all", () => {
    // Load-bearing: verify-doc-counts.ts turns a zero sum into an exit-1 with a message
    // naming the cause. If stripping ANSI ever made garbage parse as some number, the
    // gate would start comparing README against noise instead of refusing to answer.
    expect(sumSuiteLog("")).toBe(0);
    expect(sumSuiteLog("npm error code ELIFECYCLE\nTests are cool\n")).toBe(0);
    expect(sumSuiteLog("\x1b[1m\x1b[32mnothing here\x1b[39m\x1b[22m")).toBe(0);
  });
});

// ── The dbt totals: the same class as the suite count, one category short ──────────────
//
// Cold review I1. The suite count has been mechanically derived since gate-H, because "a
// number a human maintains beside a thing a machine changes" went wrong twice. The dbt
// build's totals are the SAME shape of number and were never brought under the gate: they
// are stated in four places, they change whenever a model, seed or data test is added,
// and nothing checked them.
//
// It went wrong the moment something changed them. Adding the iso_4217_currencies seed
// (one seed + its two column tests) moved the DAG from 98 nodes to 101; one of the four
// sites was updated and three were not, so README contradicted ITSELF four lines of prose
// apart and the RUNBOOK told an operator to expect a total the pipeline no longer prints
// — which inverts the exact failure that sentence exists to prevent.
//
// This block is the internal-consistency half, which needs no dbt run and so reds on a
// developer's machine the moment the four sites disagree. The other half — comparing them
// to what dbt ACTUALLY printed — lives in scripts/verify-doc-counts.ts, for the same
// reason the suite count does: a test cannot run the build it describes.

const runbook = repoFile("RUNBOOK.md");
const DBT_DOCS: ReadonlyArray<[string, string]> = [
  ["README.md", readme],
  ["RUNBOOK.md", runbook],
  ["KNOWN-ISSUES.md", knownIssues],
];

const claims = readDbtClaims(DBT_DOCS);

describe("the dbt build's totals are one number stated in four places, not four numbers", () => {

  it("the four known sites are all FOUND — a claim this gate cannot match is an ungated claim, which is the defect", () => {
    // Cold review I1 found the two README sites phrased differently ("98 build steps" vs
    // "101 dbt build steps"), which is its own reason nothing could ever have gated them.
    // The wording is now normalized, and this pin is what keeps it normalized.
    expect(claims.length, `found: ${JSON.stringify(claims.map((c) => `${c.file}: ${c.text}`), null, 1)}`)
      .toBeGreaterThanOrEqual(4);
    for (const file of ["README.md", "RUNBOOK.md", "KNOWN-ISSUES.md"]) {
      expect(claims.some((c) => c.file === file), `${file} states no matchable dbt claim`).toBe(true);
    }
  });

  it("no two sites disagree about any of steps / models / seeds / data tests / PASS / WARN / ERROR", () => {
    expect(dbtClaimFailures(claims)).toEqual([]);
  });
});

describe("readDbtTotals reads dbt's ARTIFACTS, not its stdout", () => {
  // The first design parsed the `Finished running …` / `Done. PASS=…` summary lines. It
  // was replaced after reading dbt's docs, because it would have rebuilt the defect
  // sumSuiteLog already paid for: that gate shipped, went green locally, and went red in
  // its first CI run because vitest colorizes and the pattern could not span the ANSI
  // escapes. dbt colorizes identically. run_results.json holds one entry per executed node
  // ("only executed nodes appear in the run results" — dbt's docs), which is exactly the
  // "N build steps" claim, and needs no text parsing at all.
  //
  // Fixtures are the SHAPE of dbt 1.12.0's real artifacts, hand-written rather than copied
  // wholesale so the pin states what it depends on: unique_id, status, and manifest's
  // resource_type. resource_type is read from manifest by cross-reference because dbt's
  // docs specify that ("only the unique_id is included … the full node object is recorded
  // in manifest.json"); the unique_id's `<resource_type>.<pkg>.<name>` shape is only shown
  // by example, never specified, so it is not relied on.
  const rr = (results: Array<[string, string]>) => ({
    metadata: { dbt_schema_version: RUN_RESULTS_SCHEMA },
    results: results.map(([unique_id, status]) => ({ unique_id, status })),
  });
  const mf = (types: Record<string, string>) => ({
    nodes: Object.fromEntries(Object.entries(types).map(([id, resource_type]) => [id, { resource_type }])),
  });

  const LIVE = rr([
    ["model.switchboard.customer_360", "success"],
    ["seed.switchboard.iso_4217_currencies", "success"],
    ["test.switchboard.unique_iso_4217_currencies_currency_code", "pass"],
    ["test.switchboard.assert_amounts_plausible", "warn"],
  ]);
  const LIVE_MF = mf({
    "model.switchboard.customer_360": "model",
    "seed.switchboard.iso_4217_currencies": "seed",
    "test.switchboard.unique_iso_4217_currencies_currency_code": "test",
    "test.switchboard.assert_amounts_plausible": "test",
  });

  it("counts executed nodes by their manifest resource_type, and aggregates dbt's PASS the way dbt prints it", () => {
    // dbt's printed PASS= merges `success` (models/seeds) and `pass` (tests) — confirmed
    // against the real 1.12.0 artifact, where 18 success + 82 pass is the printed PASS=100.
    expect(readDbtTotals(LIVE, LIVE_MF)).toEqual({
      steps: 4, models: 1, seeds: 1, dataTests: 2, pass: 3, warn: 1, error: 0,
    });
  });

  it("REFUSES a moved artifact schema rather than counting fields whose meaning it has not verified", () => {
    // dbt's docs: "Artifact versions may change in any minor version of dbt (v1.x.0)."
    const moved = { ...LIVE, metadata: { dbt_schema_version: "https://schemas.getdbt.com/dbt/run-results/v7.json" } };
    expect(() => readDbtTotals(moved, LIVE_MF)).toThrow(/schema/i);
  });

  it("REFUSES an executed node manifest does not carry, and a status it cannot classify — never a quietly smaller number", () => {
    expect(() => readDbtTotals(LIVE, mf({}))).toThrow(/manifest\.json does not carry/);
    const odd = rr([["model.switchboard.x", "teleported"]]);
    expect(() => readDbtTotals(odd, mf({ "model.switchboard.x": "model" }))).toThrow(/unclassified dbt status/);
    const oddType = rr([["thing.switchboard.x", "success"]]);
    expect(() => readDbtTotals(oddType, mf({ "thing.switchboard.x": "exposure" }))).toThrow(/unclassified dbt resource_type/);
  });

  it("REFUSES an empty or malformed artifact — an unreadable build must not pass as agreement", () => {
    expect(() => readDbtTotals(rr([]), mf({}))).toThrow(/zero nodes/);
    expect(() => readDbtTotals({}, LIVE_MF)).toThrow();
    expect(() => readDbtTotals(LIVE, {})).toThrow(/manifest/);
  });

  it("the docs agree with the artifacts of the build that is actually committed to CI", () => {
    // Reads the real target/ when present (a live-fire leaves it); skipped rather than
    // faked when absent, because the CI gate is the authority for this comparison.
    const dir = fileURLToPath(new URL("../../warehouse/target/", import.meta.url));
    if (!existsSync(`${dir}run_results.json`)) return;
    const live = readDbtTotals(
      JSON.parse(readFileSync(`${dir}run_results.json`, "utf8")),
      JSON.parse(readFileSync(`${dir}manifest.json`, "utf8")),
    );
    expect(dbtClaimFailures(claims, live)).toEqual([]);
  });

  it("a build that disagrees with the docs is named field by field, with the sites to update", () => {
    const drifted = { steps: 104, models: 15, seeds: 4, dataTests: 85, pass: 103, warn: 1, error: 0 };
    const failures = dbtClaimFailures(claims, drifted);
    expect(failures.join(" ")).toContain("seeds");
    expect(failures.join(" ")).toContain("steps");
    expect(failures.join(" ")).toContain("README.md");
  });
});

describe("the other two README numbers about things a machine changes", () => {
  // The cold review's follow-up sweep asked for every such number to be gated or
  // explicitly judged safe. These two were accurate when swept — which is exactly what
  // every drifted number was, the day before it drifted.
  it("'across N workspaces' matches the workspaces that actually ran tests", () => {
    const log = [
      " Test Files  6 passed (6)",
      "      Tests  59 passed (59)",
      " Test Files  1 failed | 40 passed (41)",
      "      Tests  1 failed | 677 passed (678)",
    ].join("\n");
    expect(countSuiteWorkspaces(log)).toBe(2);
    expect(countSuiteWorkspaces("")).toBe(0); // fails closed; the gate refuses to compare against 0
    expect(readmeWorkspaceClaim(readme)).toBe(9); // the word "nine", as the prose reads it
  });

  it("'N seeded fast-check properties' counts PROPERTIES, not fc.assert calls — the suite numbers them", () => {
    // Load-bearing distinction: property 4 carries two cases, so the file runs 7 tests
    // for 6 numbered properties. A gate that counted `fc.assert` would red on a true
    // README, which is how a correct gate teaches people to ignore it.
    const src = readFileSync(fileURLToPath(new URL("../../ingest/test/properties.test.ts", import.meta.url)), "utf8");
    expect(countFastCheckProperties(src)).toBe(readmePropertyClaim(readme));
    expect(countFastCheckProperties("describe('property 1: a', …) describe('property 1: b', …)")).toBe(1);
  });
});

// ── The gate's own command line ────────────────────────────────────────────────────────
//
// Cold review M4. RUNBOOK:83 told operators to run `--dbt-log`. That flag does not exist;
// the real one is `--dbt-artifacts`. The wrong spelling did not fail — argv was scanned
// with indexOf for each KNOWN flag, so an unknown one was simply never found, the gate
// fell back to its weaker consistency-only mode, printed "(no --dbt-artifacts: …)" and
// exited 0.
//
// That is worse than the wrong number the gate exists to catch. A verification gate that
// SILENTLY DOWNGRADES on a typo hands out green ticks for checks it never ran, and the
// operator's evidence that it ran is the exit code it just faked. Both flags had the
// defect, so a misspelled --suite-log skipped the test-count check the same way.
//
// Decision: an unrecognized option is an ERROR. The fallback modes stay reachable — but
// only by OMITTING a flag, which is a choice, never by misspelling one, which is a
// mistake. Silence is reserved for what was deliberately not asked for.

const runGate = (args: string[]): { code: number; out: string } => {
  const r = spawnSync("npx", ["tsx", "scripts/verify-doc-counts.ts", ...args], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

describe("verify-doc-counts refuses an option it does not recognize, instead of quietly running less", () => {
  it("the RUNBOOK's old spelling --dbt-log now FAILS and names itself — it used to pass while checking nothing", () => {
    const { code, out } = runGate(["--dbt-log", "warehouse/target"]);
    expect(code, "an unknown flag must not exit 0").not.toBe(0);
    expect(out).toContain("--dbt-log");
    expect(out).toContain("--dbt-artifacts"); // names the real one, so the fix is in the failure
  });

  it("a misspelled --suite-log fails too — the same defect existed on both flags", () => {
    const { code, out } = runGate(["--suite-logs", "/tmp/whatever.log"]);
    expect(code).not.toBe(0);
    expect(out).toContain("--suite-logs");
  });

  it("a stray positional argument fails — a path typed without its flag is the same mistake", () => {
    const { code } = runGate(["warehouse/target"]);
    expect(code).not.toBe(0);
  });

  it("the DELIBERATE weaker mode still works: omitting flags is a choice, not a typo", () => {
    const { code, out } = runGate([]);
    expect(code).toBe(0);
    expect(out).toContain("doc counts PASS");
  });
}, 60_000);
