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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  README_TEST_COUNT_CLAIMS,
  deriveRegisterCounts,
  readScoreboard,
  readmeTestCounts,
  sumSuiteLog,
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

describe("the dbt build's totals are one number stated in four places, not four numbers", () => {
  it("every `N build steps (M models, S seeds, T data tests)` claim in the docs states the same four numbers", () => {
    const claims = DBT_DOCS.flatMap(([file, text]) =>
      [...text.matchAll(/(\d+) dbt build steps \((\d+) models, (\d+) seeds, (\d+) data tests\)/g)].map(
        (m) => ({ file, claim: m[0].slice(0, 80) }),
      ),
    );
    expect(claims.length, "no dbt step claim found anywhere — this pin would be vacuous").toBeGreaterThanOrEqual(2);
    expect(new Set(claims.map((c) => c.claim)).size, `dbt step claims disagree: ${JSON.stringify(claims, null, 1)}`).toBe(1);
  });

  it("every `PASS=… WARN=… ERROR=…` claim in the docs states the same result", () => {
    const claims = DBT_DOCS.flatMap(([file, text]) =>
      [...text.matchAll(/PASS=(\d+) WARN=(\d+) ERROR=(\d+)/g)].map((m) => ({ file, claim: m[0] })),
    );
    expect(claims.length, "no dbt result claim found anywhere — this pin would be vacuous").toBeGreaterThanOrEqual(3);
    expect(new Set(claims.map((c) => c.claim)).size, `dbt result claims disagree: ${JSON.stringify(claims, null, 1)}`).toBe(1);
  });

  it("every `TOTAL=…` claim agrees with the step count stated beside it", () => {
    const totals = DBT_DOCS.flatMap(([, text]) => [...text.matchAll(/TOTAL=(\d+)/g)].map((m) => Number(m[1])));
    const steps = DBT_DOCS.flatMap(([, text]) =>
      [...text.matchAll(/(\d+) dbt build steps/g)].map((m) => Number(m[1])),
    );
    expect(totals.length, "no TOTAL= claim found — vacuous").toBeGreaterThanOrEqual(1);
    expect(new Set([...totals, ...steps]).size, `dbt TOTAL= and 'build steps' disagree: totals ${totals}, steps ${steps}`).toBe(1);
  });
});
