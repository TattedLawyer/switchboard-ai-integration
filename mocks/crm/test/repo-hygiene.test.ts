import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Repo-WIDE hygiene. hygiene.test.ts proves what the GENERATORS emit is synthetic; this
// file backs the README's stronger claim — no real emails or PII-shaped records anywhere
// in the repo — by scanning every git-tracked text file (docs, specs, journals, configs,
// scripts, tests included). Cold-review finding: "anywhere" was previously narrated, not
// enforced.

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
    expect(SYNTHETIC.test("x@notexample.com.evil.com")).toBe(false);
    expect(SSN_SHAPE.test("078" + "-05-" + "1120")).toBe(true);
    expect(US_PHONE_SHAPE.test("(415) 555" + " 0100")).toBe(true);
    expect(US_PHONE_SHAPE.test("415-555-" + "0142")).toBe(true);
    expect(US_PHONE_SHAPE.test("2026-07-22T10:00:00Z")).toBe(false); // ISO dates don't trip it
  });
});
