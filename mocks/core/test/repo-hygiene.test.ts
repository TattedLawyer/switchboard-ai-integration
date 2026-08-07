import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Repo-WIDE hygiene. The per-mock hygiene tests prove what the GENERATORS emit is
// synthetic; this file backs the README's stronger claim — no real emails or PII-shaped
// records anywhere in the repo — by scanning every git-tracked text file (docs, specs,
// journals, configs, scripts, tests included). Cold-review finding: "anywhere" was
// previously narrated, not enforced.
//
// HOME (debt-burn B6): this test's scope is the whole repository, so no workspace is a
// perfectly honest home. It moved here from the (since-retired) 2a crm mock (one arbitrary mock —
// scope and home flatly disagreed) to mocks/core, the one workspace every mock already
// depends on and where the shared synthetic-data machinery (manifest, ledger, faults)
// lives — the natural owner of "the synthetic-data claim holds everywhere". A dedicated
// root-level test workspace was considered and rejected: it would add a workspace +
// package.json for a single file, and `npm test` (--workspaces) runs this file from
// here just the same.

const root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const files = execSync("git ls-files -z", { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const texts: [string, string][] = [];
for (const f of files) {
  const buf = readFileSync(join(root, f));
  if (buf.includes(0)) continue; // binary
  texts.push([f, buf.toString("utf8")]);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SYNTHETIC = /@([A-Za-z0-9-]+\.)*example\.com$/i;
const SSN_SHAPE = /\b\d{3}-\d{2}-\d{4}\b/;
const US_PHONE_SHAPE = /\b\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/;

describe("repo-wide hygiene (every tracked text file, not just generator output)", () => {
  it("scans a plausible corpus (guards against a silently empty file list)", () => {
    expect(texts.length).toBeGreaterThan(50);
    expect(texts.some(([f]) => f === "README.md")).toBe(true);
  });

  it("every email-shaped string in the repo uses a synthetic *.example.com domain", () => {
    const offenders: string[] = [];
    for (const [f, s] of texts) {
      for (const m of s.match(EMAIL) ?? []) {
        if (!SYNTHETIC.test(m)) offenders.push(`${f}: ${m}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no SSN- or US-phone-shaped strings in any tracked file", () => {
    const offenders: string[] = [];
    for (const [f, s] of texts) {
      if (SSN_SHAPE.test(s) || US_PHONE_SHAPE.test(s)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("self-test: the detectors actually catch violations (not vacuously green)", () => {
    // Built by concatenation so this file never trips its own scan.
    const realEmail = "jane.doe@" + "gmail.com";
    expect(SYNTHETIC.test(realEmail)).toBe(false);
    expect(("contact " + realEmail).match(EMAIL)).toEqual([realEmail]);
    expect(SYNTHETIC.test("billing@nowhere.example.com")).toBe(true);
    expect(SYNTHETIC.test("x@" + "notexample.com.evil.com")).toBe(false);
    expect(SSN_SHAPE.test("078" + "-05-" + "1120")).toBe(true);
    expect(US_PHONE_SHAPE.test("(415) 555" + " 0100")).toBe(true);
    expect(US_PHONE_SHAPE.test("415-555-" + "0142")).toBe(true);
    expect(US_PHONE_SHAPE.test("2026-07-22T10:00:00Z")).toBe(false); // ISO dates don't trip it
  });
});

// F-1c cold-review I-1 guard: chaos.sh survived the CRM retirement with a reference to
// the deleted mock's LEDGER_PATH_CRM — under `set -u` the expansion aborted only the
// command SUBSTITUTION's subshell, so every green run printed `unbound variable` on
// stderr and silently dropped the hubcrm emission-ledger count from the settle line.
// bash -n cannot see it (it is a runtime expansion) and the scripts must never run
// locally, so the guard is textual: every LEDGER_PATH_<X> a script EXPANDS must be
// DEFINED in that same script. Narrow by design — this pins the exact drift class that
// shipped, not a general shell linter.
describe("shell scripts: every LEDGER_PATH_<SOURCE> expanded is defined in the same script", () => {
  const scripts = texts.filter(([f]) => f.startsWith("scripts/") && f.endsWith(".sh"));

  it("scans the three pipeline scripts (guards against a silently empty list)", () => {
    const names = scripts.map(([f]) => f);
    for (const expected of ["scripts/demo.sh", "scripts/chaos.sh", "scripts/check-demo.sh"]) {
      expect(names).toContain(expected);
    }
  });

  it("no script expands an undefined LEDGER_PATH_<SOURCE> variable", () => {
    const offenders: string[] = [];
    for (const [f, s] of scripts) {
      const defined = new Set([...s.matchAll(/^(?:export )?(LEDGER_PATH_[A-Z]+)=/gm)].map((m) => m[1]));
      // Indirect lookups (check-demo's `ledger_var="LEDGER_PATH_${up}"`) resolve from the
      // ENVIRONMENT the caller exports, not this script's own definitions — skip those;
      // the guard binds direct `$LEDGER_PATH_X` / `${LEDGER_PATH_X}` expansions.
      for (const m of s.matchAll(/\$\{?(LEDGER_PATH_[A-Z]+)\b/g)) {
        if (m[1] === "LEDGER_PATH_") continue;
        if (!defined.has(m[1])) offenders.push(`${f}: $${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// I1 (cold review, final pre-p3): after the ISO-4217 source table was removed from this
// repo, two staging-model SQL bodies still said the door enforced its list "from the same
// VENDORED source" — contradicting vendor/iso-4217/README.md, NOTICE and KNOWN-ISSUES on
// the single point the removal exists to make. They survived the prose sweep because that
// sweep read the two schema.yml files and not the .sql bodies beside them, and nothing
// mechanically looked for the claim.
//
// So look for it mechanically, tree-wide over tracked text. The rule: a line carrying a
// shipping verb, within a THREE-LINE window of a line naming the ISO-4217 source, must
// carry its own disclaimer ON THAT LINE. The window is needed because prose wraps — the
// invoices instance put "ISO-4217" and "vendored" three lines apart — but the disclaimer
// is deliberately NOT windowed: a paragraph-scoped negation search passes on any nearby
// unrelated "not", which is exactly the kind of almost-true check this repo keeps closing.
// "SIX's list-one.xml is NOT vendored" clears; "the same vendored source" does not.
const ISO_SOURCE_REF = /list-one|iso[- ]?4217/i;
const SHIPPING_VERB = /vendor(ed|ing)|bundl(ed|ing)|redistribut|checked[- ]in|\bship(s|ped)?\s+(the\s+)?(source|file|xml|table|list-one)/i;
const WINDOW = 3;
// A line clears the rule either by negating the verb ("is NOT vendored") or by scoping it
// to what the repo genuinely does ship ("ships ONLY the DERIVED artifacts").
const DISCLAIMED = /\b(not|never|no|without|stopped|avoid|only|derived|refus\w*)\b/i;

describe("no tracked file claims the ISO-4217 source table is shipped here", () => {
  const suspects = texts.filter(([f]) => f !== "mocks/core/test/repo-hygiene.test.ts");

  it("scans a plausible corpus and still sees the files that legitimately discuss the source", () => {
    const names = suspects.map(([f]) => f);
    expect(names).toContain("vendor/iso-4217/README.md");
    expect(names).toContain("warehouse/models/staging/stg_crm__deals.sql");
    expect(names).toContain("scripts/generate-iso4217.ts");
  });

  it("every line naming the source with a shipping verb negates or scopes it", () => {
    const offenders: string[] = [];
    for (const [f, s] of suspects) {
      const lines = s.split("\n");
      lines.forEach((line, i) => {
        if (!SHIPPING_VERB.test(line)) return;
        if (DISCLAIMED.test(line)) return;
        const near = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).some((l) => ISO_SOURCE_REF.test(l));
        if (!near) return;
        offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, "these lines assert the ISO-4217 source table is shipped in this repo; it is not — see vendor/iso-4217/README.md").toEqual([]);
  });

  it("self-test: the detector catches the exact sentence that shipped, and clears the honest ones", () => {
    // Built by concatenation so this file never trips its own scan.
    const bad = "the same list the door enforces from the same " + "vendored" + " source (ISO-4217)";
    const good = "SIX's list-one.xml is NOT " + "vendored" + " in this repo";
    const flags = (line: string): boolean => ISO_SOURCE_REF.test(line) && SHIPPING_VERB.test(line) && !DISCLAIMED.test(line);
    expect(flags(bad)).toBe(true);
    expect(flags(good)).toBe(false);
    expect(flags("this seed is " + "VENDORED" + " from the free-email-domains npm package")).toBe(false); // not the ISO source
    expect(flags("the ISO-4217 seed is generated by scripts/generate-iso4217.ts")).toBe(false); // no shipping verb
    expect(flags("this repository ships ONLY the derived ISO-4217 artifacts")).toBe(false); // scoped to what does ship
    expect(flags("the ISO-4217 door lives in shipped src alongside its pins")).toBe(false); // "shipped" about our own code
    expect(flags("this repo ships the list-one.xml table")).toBe(true);
  });
});

// I2 (cold review, final pre-p3): `app.listen(0)` with no host binds the WILDCARD address.
// Node sets SO_REUSEADDR, so if some other process already holds
// `127.0.0.1:<that ephemeral port>` — a published container port is the common case on a
// dev machine — the wildcard bind still SUCCEEDS, and the test's own
// `fetch("http://127.0.0.1:<port>/…")` routes to the MORE SPECIFIC loopback bind instead.
// The test then talks to a stranger. Reproduced live, not theorised: a full-suite run went
// red in door-visibility.test.ts with `HTTPParserError … 'SSH-2.0-OpenSSH_9.6p1'` — our
// HTTP client parsing someone else's SSH banner.
//
// Every listener in tests and scripts is reached over 127.0.0.1, so the rule is
// unconditional there, and they all go through `listenLoopback` (which also awaits the
// bind — passing a host makes it asynchronous). The mocks' own `src/main.ts` servers are
// deliberately EXCLUDED: those bind a configured port to serve a container network, and
// their all-interfaces bind is a separately disclosed item (KNOWN-ISSUES, "the mock
// vendors are unauthenticated and bind all interfaces").
const UNHOSTED_LISTEN = /\.listen\(\s*0\s*(?:\)|,(?!\s*["']))/g;

describe("no test or script binds an ephemeral port on all interfaces", () => {
  const scoped = texts.filter(([f]) =>
    f !== "mocks/core/test/repo-hygiene.test.ts" &&
    (f.endsWith(".test.ts") || f.startsWith("scripts/") || f.startsWith("ingest/test/helpers/")));

  it("scans a plausible corpus (guards against a silently empty file list)", () => {
    expect(scoped.length).toBeGreaterThan(40);
    expect(scoped.map(([f]) => f)).toContain("scripts/ci-fixture.ts");
    expect(scoped.map(([f]) => f)).toContain("ingest/test/door-visibility.test.ts");
  });

  it("every listen(0) in a test or script names 127.0.0.1", () => {
    const offenders: string[] = [];
    for (const [f, s] of scoped) {
      s.split("\n").forEach((line, i) => {
        for (const _ of line.matchAll(UNHOSTED_LISTEN)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, "listen(0) with no host binds 0.0.0.0 — use listenLoopback() so a port collision is a loud EADDRINUSE, not a conversation with whatever else is listening").toEqual([]);
  });

  it("self-test: the detector catches the unhosted forms and clears the hosted ones", () => {
    const hits = (line: string): number => [...line.matchAll(UNHOSTED_LISTEN)].length;
    expect(hits("const srv = app.listen(" + "0);")).toBe(1);
    expect(hits("sink = app.listen(" + "0, () => r());")).toBe(1);
    expect(hits('const srv = app.listen(0, "127.0.0.1");')).toBe(0);
    expect(hits('app.listen(0, "127.0.0.1", () => r());')).toBe(0);
    expect(hits("app.listen(port, () => {});")).toBe(0);
  });
});
