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
