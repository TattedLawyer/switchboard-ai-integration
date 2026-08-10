// Core loop / T1 pins.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizePhone, isPhoneError, DEFAULT_REGION } from "../src/phone.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "phone.ts");

describe("T1: normalisation vectors, resolved against the PH default region", () => {
  // mutation: `DEFAULT_REGION = "PH"` -> `"US"` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  4 failed | 6 passed (10)` —
  //     AssertionError: expected '+109171234567' to be '+639171234567'   (twice:
  //       "09171234567" and "0917-123-4567" both land on the US default)
  //     AssertionError: expected '+10281234567'  to be '+63281234567'
  //     AssertionError: expected '+1917123456'   to be '+63917123456'
  //   The vectors that did NOT move are the already-E.164 ones, which is the point: an
  //   international-format number carries its own country and does not depend on the
  //   default at all. That asymmetry is why the national-format vectors are here.
  const vectors: Array<[string, string]> = [
    ["09171234567", "+639171234567"],
    ["+639171234567", "+639171234567"],
    ["+63 9171234567", "+639171234567"],
    ["0917-123-4567", "+639171234567"],
    ["(02) 8123 4567", "+63281234567"],
    ["917123456", "+63917123456"],
  ];

  for (const [input, e164] of vectors) {
    it(`normalises ${JSON.stringify(input)} to ${e164}`, () => {
      const r = normalizePhone(input);
      expect(isPhoneError(r)).toBe(false);
      if (isPhoneError(r)) return;
      expect(r.e164).toBe(e164);
      expect(r.region).toBe(DEFAULT_REGION);
    });
  }

  it("returns an error rather than throwing on unreadable input", () => {
    const r = normalizePhone("not a number at all");
    expect(isPhoneError(r)).toBe(true);
  });
});

describe("T1: `raw` is what she typed, byte for byte", () => {
  // mutation: return `raw.trim()` (or any tidied form) instead of the argument -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 9 passed (10)`,
  //   AssertionError: expected '0917-123-4567' to be '  0917-123-4567  '
  it("preserves surrounding whitespace and punctuation exactly", () => {
    for (const input of ["  0917-123-4567  ", "\t+63 9171234567", "(02) 8123 4567"]) {
      const r = normalizePhone(input);
      expect(isPhoneError(r)).toBe(false);
      if (isPhoneError(r)) return;
      expect(r.raw).toBe(input);
    }
  });
});

describe("T1: the module answers no question about validity or handset type", () => {
  // mutation: add `export function isMobile(...)` to crm/src/phone.ts -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: `Tests  2 failed | 8 passed (10)` —
  //     AssertionError: expected 'isMobile' to be undefined
  //     AssertionError: expected [ 'DEFAULT_REGION', 'isMobile', ...(2) ] to deeply
  //                     equal [ 'DEFAULT_REGION', ...(2) ]
  //   i.e. the source grep names the forbidden identifier AND the export list reds.
  //
  // FALSEHOODS.md: "Don't store properties for a phone number such as validity or type."
  // The library can answer both; asking is what makes the answer land in a column.
  it("mentions no validity/type predicate anywhere in the source", () => {
    const src = readFileSync(SRC, "utf8");
    const forbidden = ["isMobile", "isValid", "getType", "getNumberType", "isPossible"];
    const found = forbidden.filter((name) => src.includes(name));
    expect(found[0]).toBeUndefined();
    expect(found).toEqual([]);
  });

  it("exports nothing beyond normalisation", async () => {
    const mod = await import("../src/phone.js");
    expect(Object.keys(mod).sort()).toEqual([
      "DEFAULT_REGION",
      "isPhoneError",
      "normalizePhone",
    ]);
  });
});
