import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { numericContractViolation } from "../src/numeric-contract.js";
import { ISO_4217_CURRENCIES, ISO_4217_PUBLISHED } from "../src/iso4217-codes.js";
import {
  EXCLUDED_CODES,
  admittedCodes,
  parseListOne,
  renderIso4217Csv,
  renderIso4217Module,
  type ListOne,
} from "../src/iso4217.js";

// #37 — the ISO-4217 allowlist at the door.
//
// Before this, `currency` was gated by `^[A-Z]{3}$` alone: a shape check that admits
// every one of the 17,576 three-letter uppercase strings, of which ~180 are currencies.
// "ABC" walked in and became a currency the mart grouped and refused sums across, and
// nothing anywhere could tell it from "USD". These pins are the membership rule.
//
// The list is not typed here — it is generated from the vendored SIX list-one.xml
// (vendor/iso-4217/, provenance in its README) into ingest/src/iso4217-codes.ts. The
// spot codes below are hand-named ON PURPOSE: they are the claim that the generated
// artifact contains real currencies and not, say, an empty set that would make every
// currency quarantine (an allowlist that admits nothing passes a "rejects ABC" test
// perfectly, and is completely broken).

const currencyViolation = (code: unknown): string | null =>
  numericContractViolation("invoice.created", { amount_cents: 100, currency: code })?.reason ?? null;

describe("the door's currency gate is ISO-4217 MEMBERSHIP, not three-letter shape", () => {
  it("'ABC' — well-shaped, uppercase, three letters, and not a currency — is refused, with a reason that names the standard and echoes the value", () => {
    const reason = currencyViolation("ABC");
    expect(reason, "ABC is not an ISO-4217 code and must not pass the door").not.toBeNull();
    expect(reason).toContain("ISO-4217");
    expect(reason).toContain('"ABC"');
  });

  it("the other shape-valid non-currencies are refused too — a single hardcoded 'ABC' check would pass while everything else walked in", () => {
    for (const fake of ["ZZZ", "QQQ", "USA", "USE", "BTC", "XYZ"]) {
      expect(currencyViolation(fake), `${fake} is not an ISO-4217 code`).not.toBeNull();
    }
  });

  it("real published codes still pass — including the ones outside the G10 habit, so the allowlist is not a five-entry stub", () => {
    for (const real of ["USD", "EUR", "PHP", "JPY", "GBP", "CHF", "SGD", "MYR", "ZAR", "IDR", "XAU"]) {
      expect(currencyViolation(real), `${real} is published in ISO-4217 list-one and must pass`).toBeNull();
    }
  });

  it("XXX ('no currency') and XTS ('reserved for testing') are EXCLUDED even though list-one publishes them — admitting XXX would let 'no currency' through as a currency", () => {
    expect(currencyViolation("XXX")).not.toBeNull();
    expect(currencyViolation("XTS")).not.toBeNull();
  });

  it("BGN is NOT admitted — SIX withdrew it in the 2026-01-01 amendment when Bulgaria adopted the euro; a hand-typed list would still be admitting it, and nothing would say so", () => {
    expect(currencyViolation("BGN"), "the vendored list is the live published one, not a remembered one").not.toBeNull();
  });

  it("case is not smoothed over: 'usd' is still refused (the door normalizes nothing — a lowercase code is a vendor bug the operator must see)", () => {
    expect(currencyViolation("usd")).not.toBeNull();
  });

  it("the pre-existing semantics are untouched: absent and explicit-null currency still pass (legacy pre-currency events must flow), and a non-string still names the field", () => {
    expect(numericContractViolation("invoice.created", { amount_cents: 100 })).toBeNull();
    expect(numericContractViolation("invoice.created", { amount_cents: 100, currency: null })).toBeNull();
    expect(currencyViolation(42)).toContain("currency");
  });

  it("every money-bearing declared type shares the gate — the rule is the contract's, not one event type's", () => {
    for (const t of ["invoice.created", "invoice.paid", "invoice.voided", "deal.updated", "invoice.finalized", "charge.succeeded", "charge.failed", "sheet.row_upserted", "hubcrm.deal.snapshot"]) {
      expect(numericContractViolation(t, { amount_cents: t === "hubcrm.deal.snapshot" ? "100" : 100, currency: "ABC" }), t).not.toBeNull();
      expect(numericContractViolation(t, { amount_cents: t === "hubcrm.deal.snapshot" ? "100" : 100, currency: "USD" }), t).toBeNull();
    }
  });
});


// ── The guard, with the source table deliberately NOT in this repo ─────────────────────
//
// This repo ships the DERIVED artifacts only — the admitted code set as a TypeScript
// module and as a dbt seed. SIX's list-one.xml is not vendored; provenance (URL,
// published date, SHA-256 of the exact bytes these artifacts were rendered from) lives in
// vendor/iso-4217/README.md.
//
// WHAT THAT COSTS, STATED PLAINLY: with the source gone, no test in this repo can
// recompute the artifacts from it, and the recorded SHA-256 is DOCUMENTARY — nothing here
// can verify it. So the guard cannot be "the two artifacts agree with each other". They
// already did, and once the source is gone that pin passes for ANY mutually consistent
// pair, including one with a code quietly dropped from both. A tautology is not an oracle.
//
// The guard therefore pins CONTENT:
//   · golden bytes  — an exact SHA-256 of each committed artifact, as a literal here, so
//                     changing an artifact requires a matching visible edit to this file;
//   · the count     — 176, as a literal, so a silent addition or deletion reds;
//   · spot codes    — named currencies that must be present, so a wholesale replacement
//                     with a different-but-consistent list reds;
//   · exclusions    — XXX and XTS must be absent, the one policy decision we made;
//   · the generator — exercised against a SYNTHETIC fixture (see the fixture's header),
//                     never an excerpt of the real table.
// The mutual pin is kept at the end as a cheap tripwire. It is not the oracle.

const ISO_SEED_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../warehouse/seeds/iso_4217_currencies.csv");
const CODES_MODULE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../src/iso4217-codes.ts");
const SYNTHETIC_XML_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures/iso4217-synthetic.xml");
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

// Golden bytes of the committed artifacts. These literals are the teeth: an edit to either
// artifact — however consistent with the other — reds until someone also edits THIS line,
// which is a deliberate, reviewable act rather than a silent drift.
const CODES_MODULE_SHA256 = "3463a66acf9dc63f178bd6dc4268328f32b33671735d88e50ce55cd3515aa386";
const SEED_SHA256 = "89aee96fe1349eb01dc74ac8d00b2b25c94cf70576c44be6f7b31f83cf912498";
// SIX list-one.xml, Pblshd="2026-01-01", the bytes these artifacts were rendered from.
// DOCUMENTARY ONLY — the file is not in this repo and nothing here can recompute it. It is
// asserted as a string so the value cannot rot silently out of the provenance README.
const SOURCE_XML_SHA256 = "838dfb991648cf36df939edd5fe3811737962b75a32252847d239cedd1e291c9";
const ADMITTED_CODE_COUNT = 176;

describe("the committed ISO-4217 artifacts are pinned by CONTENT, not by agreeing with each other", () => {
  it("golden bytes: the door's module is exactly the reviewed file", () => {
    expect(sha256(CODES_MODULE_PATH), "ingest/src/iso4217-codes.ts changed — regenerate and update the golden hash deliberately").toBe(CODES_MODULE_SHA256);
  });

  it("golden bytes: the dbt seed is exactly the reviewed file", () => {
    expect(sha256(ISO_SEED_PATH), "warehouse/seeds/iso_4217_currencies.csv changed — regenerate and update the golden hash deliberately").toBe(SEED_SHA256);
  });

  it("the count is exactly 176 — a code added or dropped reds even if both artifacts move together", () => {
    expect(ISO_4217_CURRENCIES).toHaveLength(ADMITTED_CODE_COUNT);
    expect(readFileSync(ISO_SEED_PATH, "utf8").trim().split("\n").slice(1)).toHaveLength(ADMITTED_CODE_COUNT);
  });

  it("spot codes are present — a wholesale swap for a different but self-consistent list reds here", () => {
    for (const code of ["USD", "EUR", "JPY", "GBP", "CHF", "PHP", "SGD", "MYR", "ZAR", "IDR", "AUD", "CAD", "CNY", "INR", "XAU"]) {
      expect(ISO_4217_CURRENCIES, `${code} must be admitted`).toContain(code);
    }
  });

  it("the two exclusions stay excluded — the one policy decision in the whole list", () => {
    for (const code of EXCLUDED_CODES) expect(ISO_4217_CURRENCIES).not.toContain(code);
    expect(EXCLUDED_CODES).toEqual(["XTS", "XXX"]);
  });

  it("BGN is absent — the amendment these artifacts came from is the one that withdrew it for Bulgaria's euro adoption", () => {
    expect(ISO_4217_CURRENCIES).not.toContain("BGN");
  });

  it("the published date and the source hash are recorded, and match the provenance README", () => {
    expect(ISO_4217_PUBLISHED).toBe("2026-01-01");
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../vendor/iso-4217/README.md"), "utf8");
    expect(readme, "the provenance README must carry the published date").toContain(ISO_4217_PUBLISHED);
    expect(readme, "the provenance README must carry the source SHA-256").toContain(SOURCE_XML_SHA256);
    expect(readme, "the source file must NOT be described as vendored").not.toMatch(/vendor\/iso-4217\/list-one\.xml/);
  });

  it("TRIPWIRE (not the oracle): module and seed carry the same codes, in the same order", () => {
    const [header, ...rows] = readFileSync(ISO_SEED_PATH, "utf8").trim().split("\n");
    expect(header).toBe("currency_code");
    expect(rows).toEqual([...ISO_4217_CURRENCIES]);
  });
});

describe("the generator's logic, exercised against a SYNTHETIC fixture", () => {
  // The fixture is hand-authored in list-one's shape with invented codes (Q__ is
  // unassigned by ISO 4217). Deliberately not an excerpt of the real table: a redacted
  // copy under another name would reintroduce exactly what this repo stopped shipping.
  const synthetic = (): string => readFileSync(SYNTHETIC_XML_PATH, "utf8");

  it("parses the shape: published date, deduplicated sorted codes, exclusions still present in the published set", () => {
    const list = parseListOne(synthetic());
    expect(list.published).toBe("1999-01-01");
    expect(list.codes.length).toBeGreaterThanOrEqual(150);
    expect(list.codes).toEqual([...list.codes].sort());
    expect(list.codes).toContain("XXX");
    expect(list.codes).toContain("XTS");
  });

  it("admits the published set minus the declared exclusions", () => {
    const list = parseListOne(synthetic());
    const admitted = admittedCodes(list);
    expect(admitted).toHaveLength(list.codes.length - EXCLUDED_CODES.length);
    for (const code of EXCLUDED_CODES) expect(admitted).not.toContain(code);
  });

  it("renders both artifacts from one parse — the module and the CSV cannot disagree at the source", () => {
    const list = parseListOne(synthetic());
    const csvRows = renderIso4217Csv(list).trim().split("\n").slice(1);
    const moduleCodes = [...renderIso4217Module(list).matchAll(/"([A-Z]{3})"/g)].map((m) => m[1]);
    expect(csvRows).toEqual(admittedCodes(list));
    expect(moduleCodes).toEqual(admittedCodes(list));
  });

  it("refuses what would produce a SHORT list rather than a wrong one — undated, truncated, malformed leaf", () => {
    const xml = synthetic();
    expect(() => parseListOne(xml.replace(/ Pblshd="[^"]*"/, ""))).toThrow(/Pblshd/);
    expect(() => parseListOne(xml.slice(0, 4000))).toThrow(/truncated|refusing/);
    expect(() => parseListOne(xml.replace("<Ccy>QAA</Ccy>", "<Ccy>qaa</Ccy>"))).toThrow(/alpha-3/);
  });

  it("an exclusion the standard no longer publishes is refused rather than silently doing nothing", () => {
    const list = parseListOne(synthetic());
    const withoutXxx: ListOne = { published: list.published, codes: list.codes.filter((c) => c !== "XXX") };
    expect(() => admittedCodes(withoutXxx)).toThrow(/XXX/);
  });
});
