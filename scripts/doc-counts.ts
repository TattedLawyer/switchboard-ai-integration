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
  // ANSI first. Vitest colorizes its summary depending on the environment, so the SAME
  // run yields `Tests  59 passed (59)` locally and
  // `Tests \x1b[22m \x1b[1m\x1b[32m59 passed\x1b[39m…` in CI — escape sequences land
  // between `Tests` and the digits and inside `N passed` itself, so a pattern written
  // against the plain shape matches neither. On 1ae95ea that made the gate report "no
  // \"Tests N passed\" lines" against a log that was full of them: a parser that reads
  // one of its input's two shapes reports an environment detail as a documentation lie.
  // Stripped here rather than suppressed at the producer (NO_COLOR in the workflow) so
  // that a human piping a colorized log into this by hand gets the same answer CI does.
  // Matches the CSI form (ESC `[` params… final byte), which covers every SGR colour and
  // style code vitest emits. Anchored on the ESC, so bracketed prose in a log is safe.
  const plain = log.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "");
  // Both summary shapes: "Tests  59 passed (59)" and "Tests  1 failed | 677 passed (678)".
  // Counting only the `passed` half would make a RED run silently undercount and read as
  // a README that drifted — the wrong-shaped failure pointing at the wrong cause.
  const matches = [...plain.matchAll(/Tests\s+(?:(\d+) failed \| )?(\d+) passed/g)];
  return matches.reduce((s, m) => s + Number(m[1] ?? 0) + Number(m[2]), 0);
}

// ── The dbt build's totals ─────────────────────────────────────────────────────────────
//
// Cold review I1. Same class as the suite count, one category short: the dbt DAG's size is
// stated in four doc sentences, it changes whenever a model, seed or data test is added,
// and nothing checked it. Adding one seed moved it 98 → 101 and three of the four sites
// went stale, including the RUNBOOK sentence an operator uses to decide the pipeline is
// broken.
//
// READ FROM dbt's MACHINE-READABLE ARTIFACTS, not from its stdout. The first instinct was
// to parse the `Finished running …` / `Done. PASS=…` summary lines, and that would have
// rebuilt the exact defect the suite gate already paid for: `sumSuiteLog` shipped, went
// green locally and red in its first CI run, because vitest colorizes and the pattern
// could not span the ANSI escapes. dbt colorizes the same way. A gate that parses
// human-readable output is a coin flip on an environment detail.
//
// dbt's own docs (https://docs.getdbt.com/reference/artifacts/run-results-json):
// run_results.json is "Produced by: build, clone, compile, docs generate, retry, run,
// seed, show, snapshot, test, run-operation", its `results` array holds one entry per node
// with `unique_id` and `status`, and "only executed nodes appear in the run results" —
// which is precisely what "N build steps" claims. The same page says that instead of the
// whole node "only the `unique_id` is included. (The full `node` object is recorded in
// manifest.json)", so resource_type is read from manifest.json by cross-reference, as
// documented — NOT by splitting the unique_id on ".". The `<resource_type>.<package>.<name>`
// shape is only demonstrated by example in dbt's docs, never specified, so relying on it
// would be an undocumented-format inference; it was verified to agree on our artifact
// (101/101 nodes, zero mismatches) and still not used, because a convention that happens
// to hold is not a contract.
//
// In-repo precedent, deliberately matched: scripts/verify-dbt-warns.ts already gates on
// run_results.json from the same warehouse/target directory.
//
// WHY THIS NEEDS THE RUN, stated rather than assumed. manifest.json is written by any
// parsing command — `dbt parse` "doesn't connect to your warehouse"
// (https://docs.getdbt.com/reference/commands/parse) — so a database-free node count is
// available. It is the wrong number: manifest holds every resource in the project,
// including analyses that `dbt build` never executes and a separate `disabled` array, so
// turning it into "build steps" means re-implementing dbt's build-selection rules. A
// second implementation of the thing being checked, drifting from the first, IS the defect
// class here. run_results.json answers the question dbt itself answered.

/** Artifact schema this gate was written and verified against. dbt's docs are explicit
 *  that "Artifact versions may change in any minor version of dbt (v1.x.0). Each artifact
 *  is versioned independently" (https://docs.getdbt.com/reference/artifacts/dbt-artifacts),
 *  so the version is asserted rather than assumed: a dbt upgrade that moves the schema
 *  fails HERE, naming itself, instead of silently producing a wrong count. CI pins
 *  dbt-core exactly, so reaching this error is always a deliberate act. */
export const RUN_RESULTS_SCHEMA = "https://schemas.getdbt.com/dbt/run-results/v6.json";

export interface DbtTotals {
  /** Executed nodes — the number dbt prints as TOTAL=. */
  steps: number;
  models: number;
  seeds: number;
  dataTests: number;
  pass: number;
  warn: number;
  error: number;
}

/** Statuses dbt reports per node. Models/seeds report `success`; tests report `pass`,
 *  `warn` or `fail`. dbt's printed `PASS=` aggregates `success` and `pass` — confirmed
 *  empirically against our pinned dbt 1.12.0 (82 pass + 18 success = the printed PASS=100),
 *  which is why the aggregation is written down here rather than left implicit. An
 *  UNKNOWN status throws: a status this gate cannot classify must never be silently
 *  dropped into a smaller count. */
const PASS_STATUSES = new Set(["success", "pass"]);
const WARN_STATUSES = new Set(["warn"]);
const ERROR_STATUSES = new Set(["error", "fail", "runtime error"]);
const SKIP_STATUSES = new Set(["skipped", "noop", "no-op", "partial success", "reused"]);

/** Reads dbt's artifacts. Throws — never returns a plausible-but-wrong number — when the
 *  schema moved, a node is unaccounted for, or a status cannot be classified. */
export function readDbtTotals(runResults: unknown, manifest: unknown): DbtTotals {
  const rr = runResults as { metadata?: { dbt_schema_version?: string }; results?: unknown[] };
  const mf = manifest as { nodes?: Record<string, { resource_type?: string }> };
  const schema = rr?.metadata?.dbt_schema_version;
  if (schema !== RUN_RESULTS_SCHEMA) {
    throw new Error(
      `run_results.json is schema ${JSON.stringify(schema)}; this gate was verified against ` +
        `${RUN_RESULTS_SCHEMA}. dbt versions artifacts independently and may change them in any ` +
        "minor release — re-verify the field meanings, then update RUN_RESULTS_SCHEMA.",
    );
  }
  if (!Array.isArray(rr.results)) throw new Error("run_results.json has no `results` array");
  if (!mf?.nodes) throw new Error("manifest.json has no `nodes` — resource types are read from it by cross-reference");
  const totals: DbtTotals = { steps: rr.results.length, models: 0, seeds: 0, dataTests: 0, pass: 0, warn: 0, error: 0 };
  if (totals.steps === 0) throw new Error("run_results.json executed zero nodes — that is not a build this gate can check");
  for (const raw of rr.results) {
    const r = raw as { unique_id?: string; status?: string };
    const node = r.unique_id === undefined ? undefined : mf.nodes[r.unique_id];
    if (!node) {
      throw new Error(`run_results.json names ${JSON.stringify(r.unique_id)}, which manifest.json does not carry`);
    }
    switch (node.resource_type) {
      case "model": totals.models += 1; break;
      case "seed": totals.seeds += 1; break;
      case "test": totals.dataTests += 1; break;
      case "snapshot": case "analysis": case "operation": break; // executed, but no doc claims them
      default:
        throw new Error(`unclassified dbt resource_type ${JSON.stringify(node.resource_type)} on ${r.unique_id}`);
    }
    const status = r.status ?? "";
    if (PASS_STATUSES.has(status)) totals.pass += 1;
    else if (WARN_STATUSES.has(status)) totals.warn += 1;
    else if (ERROR_STATUSES.has(status)) totals.error += 1;
    else if (!SKIP_STATUSES.has(status)) {
      throw new Error(`unclassified dbt status ${JSON.stringify(status)} on ${r.unique_id} — refusing to undercount`);
    }
  }
  return totals;
}

/** A dbt claim as a doc makes it, with where it was found. Both phrasings are matched
 *  because both are load-bearing prose: the step breakdown reads naturally in the
 *  evidence table, the PASS/WARN/ERROR line is what an operator compares their terminal
 *  against. They are NORMALIZED to one wording across all four sites (cold review I1
 *  found "98 build steps" and "101 dbt build steps" in the same file), so one pattern
 *  finds them all — an unmatched phrasing is an ungated claim, which is the defect. */
export interface DbtClaim {
  file: string;
  text: string;
  steps?: number;
  models?: number;
  seeds?: number;
  dataTests?: number;
  pass?: number;
  warn?: number;
  error?: number;
}

export function readDbtClaims(files: ReadonlyArray<readonly [string, string]>): DbtClaim[] {
  const out: DbtClaim[] = [];
  for (const [file, text] of files) {
    for (const m of text.matchAll(/(\d+) dbt build steps \((\d+) models, (\d+) seeds, (\d+) data tests\)/g)) {
      out.push({
        file,
        text: m[0],
        steps: Number(m[1]),
        models: Number(m[2]),
        seeds: Number(m[3]),
        dataTests: Number(m[4]),
      });
    }
    for (const m of text.matchAll(/PASS=(\d+) WARN=(\d+) ERROR=(\d+)(?:[^\n`]*?TOTAL=(\d+))?/g)) {
      out.push({
        file,
        text: m[0],
        pass: Number(m[1]),
        warn: Number(m[2]),
        error: Number(m[3]),
        ...(m[4] === undefined ? {} : { steps: Number(m[4]) }),
      });
    }
  }
  return out;
}

/** Every disagreement among the claims themselves, and — when `live` is given — with what
 *  dbt actually printed. Returns human-readable failure lines; empty means agreement. */
export function dbtClaimFailures(claims: readonly DbtClaim[], live?: DbtTotals | null): string[] {
  const failures: string[] = [];
  if (claims.length < 4) {
    failures.push(
      `only ${claims.length} dbt claim(s) found across the docs — the four known sites are README (×2), ` +
        "RUNBOOK and KNOWN-ISSUES; a claim whose phrasing this gate cannot match is an UNGATED claim, " +
        "which is the defect itself",
    );
  }
  const fields = ["steps", "models", "seeds", "dataTests", "pass", "warn", "error"] as const;
  for (const f of fields) {
    const stated = claims.filter((c) => c[f] !== undefined);
    const values = new Set(stated.map((c) => c[f]));
    if (values.size > 1) {
      failures.push(
        `docs disagree with each other about dbt ${f}: ` +
          stated.map((c) => `${c.file} says ${c[f]} ("${c.text}")`).join("; "),
      );
    }
    if (live && values.size >= 1 && !values.has(live[f])) {
      failures.push(
        `docs say dbt ${f} = ${[...values].join("/")}; the live build reported ${live[f]}. ` +
          `Update every site: ${[...new Set(stated.map((c) => c.file))].join(", ")}.`,
      );
    }
  }
  return failures;
}

// ── Two more numbers README states about things a machine changes ──────────────────────
//
// Found by the cold review's follow-up sweep ("grep every doc for any other number
// describing something a machine changes"). Both were accurate at the time of the sweep;
// both are gated anyway, because "accurate today" is what every one of these numbers was
// before it drifted. The judgment calls that were NOT gated are recorded in the task
// report with the reason, not left silent.

/** Workspaces that ran tests, from the same log the suite count is summed from. This is
 *  the honest denominator for README's "across nine workspaces": a workspace with no
 *  tests contributes no block, and claiming it did would be the lie. */
export function countSuiteWorkspaces(log: string): number {
  const plain = log.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "");
  return [...plain.matchAll(/Test Files\s+(?:\d+ failed \| )?\d+ passed/g)].length;
}

/** README's "nine workspaces" as a word, because that is how the prose reads. */
const NUMBER_WORDS: Record<string, number> = {
  four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
export function readmeWorkspaceClaim(markdown: string): number | null {
  const m = /across (\w+) workspaces/.exec(markdown);
  if (!m) return null;
  return NUMBER_WORDS[m[1]] ?? Number(m[1]) ?? null;
}

/** README's "N seeded fast-check properties". The suite numbers its properties
 *  ("property 1:" … "property 6:") and one property carries two cases, so the claim is a
 *  count of PROPERTIES, not of tests — which is why it reads 6 beside 7 test names, and
 *  why this derivation counts the distinct numbers rather than the `fc.assert` calls. */
export function countFastCheckProperties(propertiesTestSource: string): number {
  return new Set([...propertiesTestSource.matchAll(/property (\d+):/g)].map((m) => m[1])).size;
}
export function readmePropertyClaim(markdown: string): number | null {
  const m = /(\d+) seeded fast-check properties/.exec(markdown);
  return m ? Number(m[1]) : null;
}

// ── The gate's own command line ────────────────────────────────────────────────────────
//
// Cold review M4. Every flag was read with `argv.indexOf("--flag")`, which cannot tell
// "not asked for" from "asked for, misspelled" — so `--dbt-log` (the spelling our own
// RUNBOOK published) ran the weaker consistency-only mode and exited 0. A verification
// gate that silently downgrades on a typo is worse than the drift it exists to catch: it
// issues a green tick for a check it never ran.
//
// So parsing is EXHAUSTIVE rather than by-lookup: every token must be consumed by a known
// option, and anything left over is an error naming itself. The weaker modes stay
// reachable by OMITTING a flag — a choice — never by misspelling one — a mistake.

export interface DocCountArgs {
  suiteLog?: string;
  dbtArtifacts?: string;
}

export const KNOWN_FLAGS = ["--suite-log", "--dbt-artifacts"] as const;

/** Throws on anything unrecognized, on a flag given twice, and on a flag missing its
 *  value. Never returns a partially-understood command line. */
export function parseDocCountArgs(argv: readonly string[]): DocCountArgs {
  const out: DocCountArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const takeValue = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`${token} needs a value (got ${v === undefined ? "nothing" : JSON.stringify(v)})`);
      }
      i += 1;
      return v;
    };
    switch (token) {
      case "--suite-log":
        if (out.suiteLog !== undefined) throw new Error("--suite-log given twice");
        out.suiteLog = takeValue();
        break;
      case "--dbt-artifacts":
        if (out.dbtArtifacts !== undefined) throw new Error("--dbt-artifacts given twice");
        out.dbtArtifacts = takeValue();
        break;
      default:
        throw new Error(
          `unrecognized argument ${JSON.stringify(token)}. Known options: ${KNOWN_FLAGS.join(", ")}. ` +
            "Omitting a flag runs the weaker check deliberately; MISSPELLING one used to do it silently, " +
            "which is why this is now an error.",
        );
    }
  }
  return out;
}

// ── Two more counts README states about the tree ───────────────────────────────────────
// Cold review M5. Same treatment as the rest: derived, not hand-verified.

/** dbt staging models on disk. README calls them "9 staging views", which is what they
 *  are — every model under models/staging materializes as a view. */
export function countStagingModels(fileNames: readonly string[]): number {
  return fileNames.filter((f) => f.endsWith(".sql")).length;
}
export function readmeStagingClaim(markdown: string): number | null {
  const m = /(\d+) staging views/.exec(markdown);
  return m ? Number(m[1]) : null;
}

/** Mock SOURCE servers: every workspace under mocks/ except `core`, which is the shared
 *  library (`@switchboard/mock-core`) the same README sentence names separately — it
 *  serves nothing. Excluding it by name rather than by counting directories is the whole
 *  point: a future non-server workspace under mocks/ must force this decision again
 *  instead of quietly inflating the number. */
export const NON_SERVER_MOCK_WORKSPACES = ["core"] as const;
export function countMockSourceServers(dirNames: readonly string[]): number {
  return dirNames.filter((d) => !(NON_SERVER_MOCK_WORKSPACES as readonly string[]).includes(d)).length;
}
export function readmeMockServerClaim(markdown: string): number | null {
  const m = /(\w+) mock source servers/.exec(markdown);
  return m ? (NUMBER_WORDS[m[1]] ?? Number(m[1]) ?? null) : null;
}
