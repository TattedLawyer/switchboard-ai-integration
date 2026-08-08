// Regenerates warehouse/seeds/numeric_bounds.csv from the numeric contract
// (ingest/src/numeric-contract.ts) — the Wave-5 bound emission.
//
// Run: npx tsx scripts/generate-numeric-bounds-seed.ts   (then commit the CSV diff)
//
// Why a committed CSV instead of a build-time emission: same rationale as the
// free_email_domains seed — warehouse inputs stay reviewable tree state, dbt builds
// reproduce from a checkout alone, and a bound change arrives as a reviewable diff,
// never as a silent side effect. The rendering itself lives in
// ingest/src/numeric-bounds-seed.ts so the consistency pins in
// ingest/test/numeric-bounds-seed.test.ts exercise the exact same code path; a stale
// or hand-edited committed file reds the suite, and re-running this script is the fix.
// Same relative-import exemption as ci-fixture.ts (script code, not shipped src).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { numericBoundRows, renderNumericBoundsCsv } from "../ingest/src/numeric-bounds-seed.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const seedPath = join(repoRoot, "warehouse/seeds/numeric_bounds.csv");
const next = renderNumericBoundsCsv();
const prev = ((): string | null => {
  try {
    return readFileSync(seedPath, "utf8");
  } catch {
    return null;
  }
})();
writeFileSync(seedPath, next);
console.log(
  prev === next
    ? `seed unchanged (${numericBoundRows().length} bound rows)`
    : `seed written: ${numericBoundRows().length} bound rows → ${seedPath}`,
);
