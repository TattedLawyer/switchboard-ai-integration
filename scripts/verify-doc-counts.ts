#!/usr/bin/env tsx
// The gate for the repo's two published headline numbers.
//
// Two checks, because they need different inputs:
//
//   1. KNOWN-ISSUES.md's scoreboard against the file it scores. Pure text, no run
//      needed — also pinned by ingest/test/doc-counts.test.ts, which is where a
//      developer meets it first.
//   2. README's test count against the SUITE. This one cannot live inside the suite
//      (a test cannot count the run it is part of), so it reads the log of a real
//      `npm test` and sums the per-workspace "Tests N passed" lines — exactly the
//      summation the gate-H merge reviewer did by hand, mechanised.
//
// Usage:
//   npx tsx scripts/verify-doc-counts.ts                       # check 1 only
//   npx tsx scripts/verify-doc-counts.ts --suite-log run.log   # checks 1 and 2
//
// Why the log rather than a fresh run: `npm test` is the expensive thing CI already
// does, and re-running it to count it would double the CI's longest step to check a
// number. Passing the log the real run produced also means the number checked is the
// number that actually went green, not a second run's.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deriveRegisterCounts, readScoreboard, readmeTestCounts, sumSuiteLog } from "./doc-counts.js";

const repoFile = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

const failures: string[] = [];

// ---- 1. the register scores itself honestly -------------------------------------
const knownIssues = repoFile("KNOWN-ISSUES.md");
const derived = deriveRegisterCounts(knownIssues);
const published = readScoreboard(knownIssues);
if (published === null) {
  failures.push("KNOWN-ISSUES.md: the scoreboard table could not be parsed — its shape changed");
} else {
  const rows: [string, number, number][] = [
    ["open defects", published.openDefects, derived.openDefects],
    ["design disclosures", published.designDisclosures, derived.designDisclosures],
    ["paid (struck)", published.paid, derived.paid],
  ];
  for (const [label, said, is] of rows) {
    if (said !== is) {
      failures.push(
        `KNOWN-ISSUES.md scoreboard: ${label} says ${said}, the file holds ${is}. ` +
          "Update the table (the derivation is printed beside each row).",
      );
    }
  }
}
if (derived.partIIOwnerless.length > 0) {
  failures.push(
    "KNOWN-ISSUES.md Part II: entries with no `Owner:` line — Part II's own rule is that " +
      `every entry names one, and an ownerless entry is invisible to the count:\n  - ${derived.partIIOwnerless.join("\n  - ")}`,
  );
}

// ---- 2. README's test count against the suite that ran --------------------------
const readme = repoFile("README.md");
const claims = readmeTestCounts(readme);
if (claims.length === 0) {
  failures.push("README.md: no test-count claim found — this gate has nothing to check, which is itself a failure");
} else if (new Set(claims).size !== 1) {
  failures.push(`README.md: its test-count claims disagree with each other: ${claims.join(", ")}`);
}

const logFlag = process.argv.indexOf("--suite-log");
if (logFlag !== -1) {
  const path = process.argv[logFlag + 1];
  if (path === undefined) {
    failures.push("--suite-log needs a path");
  } else {
    const total = sumSuiteLog(readFileSync(path, "utf8"));
    if (total === 0) {
      failures.push(
        `${path}: no "Tests N passed" lines — this is not a full \`npm test\` log, and a zero ` +
          "sum must not read as agreement with a README that claims zero tests",
      );
    } else if (claims.length > 0 && claims[0] !== total) {
      failures.push(
        `README.md claims ${claims[0]} tests; the suite log sums to ${total}. ` +
          "Update all three README claims to the measured number.",
      );
    } else {
      console.log(`README test count: ${total} — matches the suite log at ${path}`);
    }
  }
} else {
  console.log("(no --suite-log: README's test count was checked for internal consistency only)");
}

if (failures.length > 0) {
  console.error(`\ndoc counts FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `doc counts PASS — KNOWN-ISSUES: ${derived.openDefects} open / ${derived.designDisclosures} disclosures / ${derived.paid} paid`,
);
