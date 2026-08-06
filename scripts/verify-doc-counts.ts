#!/usr/bin/env tsx
// The gate for every published number this repo states about something a machine changes.
//
// It started as two headline numbers and is now eleven, across README, RUNBOOK and
// KNOWN-ISSUES. The rule that earned each one a place here is the same: a number a human
// maintains beside a thing a machine changes will drift, and the drift is invisible until
// a stranger checks.
//
// FOUR groups of checks, split by the input each one needs:
//
//   1. TEXT ONLY — always run, no inputs.
//      · KNOWN-ISSUES.md's scoreboard against the file it scores (open / disclosures /
//        paid), also pinned by ingest/test/doc-counts.test.ts, which is where a developer
//        meets it first.
//      · README's test-count claims against EACH OTHER (three copies that must agree).
//      · README's "N staging views" against warehouse/models/staging.
//      · README's "N mock source servers" against the mocks/ workspaces (minus mock-core,
//        which is the shared library, excluded BY NAME).
//      · README's "N seeded fast-check properties" against the numbered properties in
//        ingest/test/properties.test.ts.
//      · The dbt claims against EACH OTHER — which is what catches the common case, a
//        sibling missed. Adding one seed moved the DAG 98 -> 101 and three of four sites
//        went stale, including the RUNBOOK sentence an operator uses to decide the
//        pipeline is broken.
//
//   2. NEEDS --suite-log — README's test count and workspace count against the SUITE.
//      Cannot live inside the suite (a test cannot count the run it is part of), so it
//      reads the log of a real `npm test` and sums the per-workspace "Tests N passed"
//      lines — the summation the gate-H merge reviewer did by hand, mechanised.
//
//   3. NEEDS --dbt-artifacts — the dbt totals against dbt's OWN run_results.json +
//      manifest.json, never against its colorized stdout.
//
// Usage:
//   npx tsx scripts/verify-doc-counts.ts                                     # group 1 only
//   npx tsx scripts/verify-doc-counts.ts --suite-log run.log                 # + group 2
//   npx tsx scripts/verify-doc-counts.ts --dbt-artifacts warehouse/target    # + group 3
//   (both flags together is what CI runs)
//
// Omitting a flag runs the weaker check DELIBERATELY and says so on stdout. Misspelling
// one is an error — see the parser note below.
//
// EXIT CODES, and they mean different things on purpose:
//   0  every check that ran, passed
//   1  a CHECK FAILED — a documented number disagrees with reality. Fix the document.
//   2  USAGE ERROR — the command line was malformed. Fix the invocation; no check ran.
// The split matters because the two need opposite responses, and a wrapper or an operator
// reading only the exit code could not previously tell them apart. 2 is the conventional
// usage-error code: Python's argparse documents "exit with a status code of 2" for an
// invalid argument list, and POSIX getopt() treats an unrecognised option as an error
// condition with its own return value and a stderr diagnostic on by default. Neither
// standard says anything about this script — the convention is applied because the
// distinction is operationally real here.
//
// Why a log rather than a fresh run: `npm test` is the expensive thing CI already does,
// and re-running it to count it would double CI's longest step to check a number. Passing
// the log the real run produced also means the number checked is the number that actually
// went green, not a second run's.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  dbtClaimFailures,
  deriveRegisterCounts,
  readDbtTotals,
  countFastCheckProperties,
  countSuiteWorkspaces,
  readmePropertyClaim,
  readmeWorkspaceClaim,
  countMockSourceServers,
  countStagingModels,
  parseDocCountArgs,
  readmeMockServerClaim,
  readmeStagingClaim,
  readDbtClaims,
  readScoreboard,
  readmeTestCounts,
  sumSuiteLog,
} from "./doc-counts.js";

const repoPath = (rel: string): string => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const repoFile = (rel: string): string => readFileSync(repoPath(rel), "utf8");

// Cold review M4: parse the command line EXHAUSTIVELY before doing any work. A flag this
// script does not recognize is an error, not a silent fall-through to a weaker check.
//
// HISTORICAL NOTE — `--dbt-log` below is the flag that NEVER EXISTED. It is named here
// only because our own RUNBOOK published it and it used to pass while verifying nothing:
// flags were read with argv.indexOf, which structurally cannot tell "not asked for" from
// "asked for, misspelled". The real flag is `--dbt-artifacts`, as the usage block above
// states. This is the only place in this file that names the broken spelling.
const USAGE_ERROR = 2; // not 1 — see the EXIT CODES note in the header
let args;
try {
  args = parseDocCountArgs(process.argv.slice(2));
} catch (e) {
  console.error(`doc counts USAGE ERROR: ${(e as Error).message}`);
  process.exit(USAGE_ERROR);
}

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

if (args.suiteLog !== undefined) {
  const path = args.suiteLog;
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
  const wsClaim = readmeWorkspaceClaim(readme);
  const wsReal = countSuiteWorkspaces(readFileSync(path, "utf8"));
  if (wsClaim === null) {
    failures.push("README.md: the 'across N workspaces' claim is gone — this gate has nothing to check");
  } else if (wsReal > 0 && wsClaim !== wsReal) {
    failures.push(`README.md claims ${wsClaim} workspaces; the suite log holds ${wsReal} workspace blocks`);
  }
} else {
  console.log("(no --suite-log: README's test count was checked for internal consistency only)");
}

// ---- 2b. two more README numbers about things a machine changes ------------------
const propClaim = readmePropertyClaim(readme);
const propReal = countFastCheckProperties(repoFile("ingest/test/properties.test.ts"));
if (propClaim === null) {
  failures.push("README.md: the 'N seeded fast-check properties' claim is gone — this gate has nothing to check");
} else if (propClaim !== propReal) {
  failures.push(
    `README.md claims ${propClaim} seeded fast-check properties; ingest/test/properties.test.ts numbers ${propReal}`,
  );
}

// M5: two more README counts about the tree.
const stagingClaim = readmeStagingClaim(readme);
const stagingReal = countStagingModels(readdirSync(repoPath("warehouse/models/staging")));
if (stagingClaim === null) {
  failures.push("README.md: the 'N staging views' claim is gone — this gate has nothing to check");
} else if (stagingClaim !== stagingReal) {
  failures.push(`README.md claims ${stagingClaim} staging views; warehouse/models/staging holds ${stagingReal} models`);
}

const mockClaim = readmeMockServerClaim(readme);
const mockReal = countMockSourceServers(
  readdirSync(repoPath("mocks"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name),
);
if (mockClaim === null) {
  failures.push("README.md: the 'N mock source servers' claim is gone — this gate has nothing to check");
} else if (mockClaim !== mockReal) {
  failures.push(
    `README.md claims ${mockClaim} mock source servers; mocks/ holds ${mockReal} server workspaces ` +
      "(mock-core is the shared library, excluded by name)",
  );
}

// ---- 3. the dbt totals, against each other and against the build ----------------
const dbtClaims = readDbtClaims([
  ["README.md", readme],
  ["RUNBOOK.md", repoFile("RUNBOOK.md")],
  ["KNOWN-ISSUES.md", knownIssues],
]);
// Read from dbt's ARTIFACTS, never from its stdout: run_results.json holds one entry per
// executed node ("only executed nodes appear in the run results" — dbt's own docs), which
// is exactly what "N build steps" claims, and manifest.json carries the resource_type that
// run_results deliberately omits. Parsing the human-readable summary instead would rebuild
// the ANSI fragility that took sumSuiteLog red in its first CI run. Same artifact, same
// directory, as scripts/verify-dbt-warns.ts already uses.
let liveDbt = null;
if (args.dbtArtifacts !== undefined) {
  const dir = args.dbtArtifacts;
  try {
    liveDbt = readDbtTotals(
      JSON.parse(readFileSync(`${dir}/run_results.json`, "utf8")),
      JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8")),
    );
    console.log(
      `dbt totals from ${dir}: ${liveDbt.steps} steps (${liveDbt.models} models, ${liveDbt.seeds} seeds, ` +
        `${liveDbt.dataTests} data tests) — PASS=${liveDbt.pass} WARN=${liveDbt.warn} ERROR=${liveDbt.error}`,
    );
  } catch (e) {
    // Fails closed on purpose: an absent, half-written or schema-moved artifact must
    // never read as "the docs agree with reality".
    failures.push(`could not read dbt artifacts from ${dir}: ${(e as Error).message}`);
  }
} else {
  console.log("(no --dbt-artifacts: the dbt totals were checked for cross-document consistency only)");
}
failures.push(...dbtClaimFailures(dbtClaims, liveDbt));

if (failures.length > 0) {
  // Exit 1, deliberately NOT the usage code: every check that could run, ran — and a
  // documented number disagrees with reality. The fix is in a document, not in the
  // command line.
  console.error(`\ndoc counts FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `doc counts PASS — KNOWN-ISSUES: ${derived.openDefects} open / ${derived.designDisclosures} disclosures / ${derived.paid} paid`,
);
