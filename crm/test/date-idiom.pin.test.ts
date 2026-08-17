// THE DATE-IDIOM PIN — a source-text sweep of `crm/**` for UTC-date extraction idioms.
//
// THE FAMILY THIS PINS AGAINST: mixing a UTC-derived calendar date with Asia/Manila-relative
// data. One root cause produced five defects at once (fixed 2026-08-16): a fixture seeded
// from the machine clock that stopped constructing its own scenario near Manila midnight; a
// UTC "tomorrow" that redded a green system 16:00-24:00 UTC daily; two guard-boundary pins
// that went VACUOUS for the same eight hours; and a production rationale that displayed the
// previous Manila day for any touch in the 00:00-08:00 Manila band. The banned spellings all
// extract a date from an instant in the UTC frame: toISOString-then-slice-first-10,
// split-on-"T"-take-first, and substring-first-10 (the exact regexes are below — this
// header names them rather than spelling them so the pin does not red on its own prose).
//
// THE SANCTIONED ALTERNATIVES — the right thing is the short thing:
//   · production: `dueDateIn(at, settings.timezone)` (proposer.ts) — HER calendar date;
//   · tests: `TEST_INSTANT` (a fixed instant mid-Manila-day) and `dayAfter(dueDate)` (pure
//     calendar arithmetic on a read-back `due_date`, no clock) in helpers/crmdb.ts.
//
// 🚨 THE HONEST LIMIT OF A SOURCE-TEXT SWEEP: it is defeated by ordinary idiom, not
// trickery — `getUTCFullYear()` concatenation, `Intl` with `timeZone: "UTC"`, a date
// library's `format(d, "yyyy-MM-dd")` would all pass this file while committing the same
// error. It pins the three spellings this repo actually wrote, nothing more. The idiom
// space here is narrow (no date libraries anywhere in the repo), which is why the sweep is
// still worth its one file; it is a tripwire, not a proof. There is deliberately no ESLint
// here — the repo has no lint toolchain at all, and installing one to express three regexes
// would be all maintenance and no additional catch.
//
// mutation: add any banned spelling to a non-allowlisted file under crm/ -> red.
//           RUN ✅ 2026-08-16, all three spellings:
//   · reverting proposer.ts's rationale render to the UTC form ->
//       `Tests  1 failed (1)` — "src/proposer.ts:378 [toISOString-date-slice] …"
//   · a temp src file carrying the other two ->
//       `Tests  1 failed (1)` — "[split-on-T] …" and "[substring-0-10] …", both listed
//   restored -> `Tests  1 passed (1)`.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CRM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Files audited and left alone ON PURPOSE (adversarial review, 2026-08-16 — twice):
 *  their date literals feed `follow_ups.due_date` for rows the SAME statement compares,
 *  so the frame cancels out; rewriting them buys nothing. Additions to this list need the
 *  same audit, not a reflex. */
const ALLOWLIST = new Set<string>(["test/touch.test.ts", "test/migration-016.test.ts"]);

// Patterns are spelled so this file's own source cannot match them.
const IDIOMS: Array<{ name: string; re: RegExp }> = [
  { name: "toISOString-date-slice", re: /\.toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/ },
  { name: "split-on-T", re: /\.split\(\s*["'`]T["'`]\s*\)\s*\[\s*0\s*\]/ },
  { name: "substring-0-10", re: /\.substring\(\s*0\s*,\s*10\s*\)/ },
];

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("the date-idiom pin: no UTC-date extraction in crm/** outside the allowlist", () => {
  it("finds none of the three banned spellings", () => {
    const violations: string[] = [];
    for (const file of [...tsFilesUnder(path.join(CRM_ROOT, "src")), ...tsFilesUnder(path.join(CRM_ROOT, "test"))]) {
      const rel = path.relative(CRM_ROOT, file);
      if (ALLOWLIST.has(rel)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const idiom of IDIOMS) {
          if (idiom.re.test(line)) violations.push(`${rel}:${i + 1} [${idiom.name}] ${line.trim()}`);
        }
      });
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
