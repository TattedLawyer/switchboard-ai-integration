import { describe, expect, it } from "vitest";
import { numericContractViolation } from "../src/numeric-contract.js";

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
    for (const real of ["USD", "EUR", "PHP", "JPY", "GBP", "CHF", "SGD", "MYR", "ZAR", "BGN", "XAU"]) {
      expect(currencyViolation(real), `${real} is published in ISO-4217 list-one and must pass`).toBeNull();
    }
  });

  it("XXX ('no currency') and XTS ('reserved for testing') are EXCLUDED even though list-one publishes them — admitting XXX would let 'no currency' through as a currency", () => {
    expect(currencyViolation("XXX")).not.toBeNull();
    expect(currencyViolation("XTS")).not.toBeNull();
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
