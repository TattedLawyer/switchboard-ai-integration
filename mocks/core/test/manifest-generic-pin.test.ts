import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { generateManifest } from "../src/manifest.js";

// The 2b-D3 baseline wall: every existing test, expectation, CI fixture, and
// verify-identity run sits on the GENERIC profile at seed 42 — so the vertical-profile
// work may not move it by a byte. The fixture was captured from the tree at base commit
// 17d6624, BEFORE the profile content landed; deep-equality against it (not a re-run of
// the generator) is what makes this a pin rather than a tautology.
//
// AMENDED ONCE (F-1c, SPEC CHANGE, deliberate): the five domain-evidence support
// requesters' emails (S-0010..S-0014) moved from flavor addresses at the example.com
// root to help@<their-domain-evidence> — the faithful Case wire carries only the
// supplied-* intake fields, so staging derives the support arm's domain evidence from
// SuppliedEmail, and the universe must put the evidence inside the email
// (wire-evidence.test.ts is the standing pin). The fixture was regenerated for exactly
// those five email fields; everything else remains the 17d6624 bytes, and this wall
// resumes its no-drift duty from here.
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/manifest-generic-42.json", import.meta.url), "utf8"),
) as unknown;

describe("generic profile output is frozen at the pre-profile baseline", () => {
  it("generateManifest(42, 'generic') deep-equals the fixture captured at 17d6624", () => {
    expect(JSON.parse(JSON.stringify(generateManifest(42, "generic")))).toEqual(fixture);
  });

  it("the DEFAULT profile is generic — callers that never heard of profiles get the identical baseline", () => {
    expect(JSON.parse(JSON.stringify(generateManifest(42)))).toEqual(fixture);
  });
});
