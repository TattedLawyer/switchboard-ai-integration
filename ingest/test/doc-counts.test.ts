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
