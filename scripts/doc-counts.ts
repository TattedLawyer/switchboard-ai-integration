// The repo's two published headline numbers, as DERIVATIONS rather than as prose.
//
// Gate-H C1: KNOWN-ISSUES.md's scoreboard said "20 open defects" and published a
// hand-counting method against a commit that could not carry it. Twelve bullets landed
// in one commit without a recount and the number was wrong by ~55% within days. Gate-H
// I1: README said "857 tests" three times while the suite ran 883. Both are the same
// failure — a number a human maintains beside a thing a machine changes.
//
// So neither number is maintained by hand any more. This module derives them; the pin
// (`ingest/test/doc-counts.test.ts`) reds when a doc and its derivation disagree, and
// `scripts/verify-doc-counts.ts` runs the same checks in CI plus the one that needs the
// live suite log.

/** The number of places README states the suite's test count. Three, deliberately: the
 *  CI bullet, the test-count bullet and the measured-results table each need it in
 *  context. They must all be the SAME number — three unpinned copies drifting apart is
 *  how I1 happened. */
export const README_TEST_COUNT_CLAIMS = 3;

export interface RegisterCounts {
  /** Part II top-level bullets that name an `Owner:` and are not struck through. Naming
   *  an owner is Part II's OWN entry rule, which is why it is the right predicate: the
   *  four paid multi-tenancy sub-items kept in place for readability name no owner and
   *  fall out automatically, rather than being subtracted by a hand-maintained "− 4". */
  openDefects: number;
  /** Part I top-level bullets. */
  designDisclosures: number;
  /** Part III bullets struck through — the paid history. */
  paid: number;
  /** Part II entries with no owner. Must be empty: an entry that names neither a phase
   *  nor a trigger "does not belong in this file" by the file's own rule, and an
   *  ownerless entry is invisible to the count above. */
  partIIOwnerless: string[];
}

/** Top-level markdown list items in `lines`, each returned with its continuation lines
 *  (indented text, blank lines, nested bullets) joined back together. A `#` heading ends
 *  the current item — headings are never continuations. */
function topLevelBullets(lines: readonly string[]): string[] {
  const out: string[][] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    if (/^- /.test(line)) {
      if (cur) out.push(cur);
      cur = [line];
    } else if (cur) {
      if (/^#/.test(line)) {
        out.push(cur);
        cur = null;
      } else {
        cur.push(line);
      }
    }
  }
  if (cur) out.push(cur);
  return out.map((b) => b.join("\n"));
}

/** The three `# Part …` sections, in file order. */
function parts(markdown: string): string[][] {
  const lines = markdown.split("\n");
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/^# Part /.test(l)) starts.push(i);
  });
  return starts.map((s, k) => lines.slice(s + 1, starts[k + 1] ?? lines.length));
}

const isStruck = (bullet: string): boolean => bullet.startsWith("- ~~");
const namesOwner = (bullet: string): boolean => /Owner:/.test(bullet);
/** First line of a bullet, trimmed for a failure message. */
const label = (bullet: string): string => bullet.split("\n")[0].slice(0, 88);

export function deriveRegisterCounts(markdown: string): RegisterCounts {
  const [partI, partII, partIII] = parts(markdown);
  if (partI === undefined || partII === undefined || partIII === undefined) {
    throw new Error("KNOWN-ISSUES.md: expected three `# Part …` sections");
  }
  const two = topLevelBullets(partII);
  return {
    openDefects: two.filter((b) => !isStruck(b) && namesOwner(b)).length,
    designDisclosures: topLevelBullets(partI).length,
    paid: topLevelBullets(partIII).filter(isStruck).length,
    // The paid multi-tenancy sub-items are the deliberate exception: they sit under a
    // "**Paid (migration 006).**" lead-in inside an otherwise-open entry, and carry no
    // owner because they have none — they are done.
    partIIOwnerless: two
      .filter((b) => !isStruck(b) && !namesOwner(b) && !/^- (Uniqueness is now|`tenant_id` is present|A tenant is \*\*required|Row-level security is enabled)/.test(b))
      .map(label),
  };
}

export interface Scoreboard {
  openDefects: number;
  designDisclosures: number;
  paid: number;
}

/** Reads the published scoreboard table. Returns null when the table is absent or its
 *  shape changed — the caller treats that as a failure, not as "nothing to check". */
export function readScoreboard(markdown: string): Scoreboard | null {
  const row = (label: string): number | null => {
    const m = markdown.match(new RegExp(`^\\| \\*\\*${label}\\*\\*[^|]*\\| \\*\\*(\\d+)\\*\\*`, "m"));
    return m ? Number(m[1]) : null;
  };
  const openDefects = row("Open defects");
  const designDisclosures = row("Design disclosures");
  const paid = row("Paid");
  if (openDefects === null || designDisclosures === null || paid === null) return null;
  return { openDefects, designDisclosures, paid };
}

/** Every test-count claim README makes, in file order. */
export function readmeTestCounts(markdown: string): number[] {
  return [...markdown.matchAll(/(\d{3,5}) (?:automated )?tests/g)].map((m) => Number(m[1]));
}

/** Sums the per-workspace `Tests  N passed` lines a full `npm test` prints. The suite
 *  total cannot be measured from inside the suite, so this reads the real run's log —
 *  the same summation the merge reviewer did by hand with grep+awk. */
export function sumSuiteLog(log: string): number {
  // Both summary shapes: "Tests  59 passed (59)" and "Tests  1 failed | 677 passed (678)".
  // Counting only the `passed` half would make a RED run silently undercount and read as
  // a README that drifted — the wrong-shaped failure pointing at the wrong cause.
  const matches = [...log.matchAll(/Tests\s+(?:(\d+) failed \| )?(\d+) passed/g)];
  return matches.reduce((s, m) => s + Number(m[1] ?? 0) + Number(m[2]), 0);
}
