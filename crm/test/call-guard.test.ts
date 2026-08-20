// Call allowlist pins — the call twin of email-guard.test.ts. PURE: no DB, no clock, no
// network. The executor-level and transport-level halves of these properties are pinned in
// call-executor-allowlist.test.ts and call-transport-allowlist.test.ts; this file pins the
// one place the env string becomes a list, and the one function that answers "may this
// number be dialled".
import { describe, it, expect } from "vitest";
import { parsePhoneAllowlist, checkCallable } from "../src/call-guard.js";

describe("parsePhoneAllowlist — fail closed, throw loud (A1/A2)", () => {
  // mutation (A2): replace the malformed-entry throw in parsePhoneAllowlist with
  //   `continue` (drop the entry silently) -> the malformed rows red.
  //   RUN ✅ 2026-08-19 — observed (this file alone):
  //     Tests  6 failed | 19 passed (25)
  //     AssertionError: expected [Function] to throw an error
  //     × a national-format number throws at parse time, naming SWITCHBOARD_PHONE_ALLOWLIST
  it.each([undefined, "", "   ", "\t\n"])(
    "unset/empty/whitespace (%j) yields the EMPTY allowlist — refuse everything, throw nothing",
    (raw) => {
      expect(parsePhoneAllowlist(raw as string | undefined)).toEqual([]);
    },
  );

  it("parses a comma-separated list of E.164 numbers, trimmed and deduplicated", () => {
    expect(
      parsePhoneAllowlist(" +639171112222 , +14155550100, +639171112222 "),
    ).toEqual(["+639171112222", "+14155550100"]);
  });

  it("the parsed list is FROZEN — no caller can widen it after the CLI edge", () => {
    const list = parsePhoneAllowlist("+639171112222");
    expect(Object.isFrozen(list)).toBe(true);
    expect(() => (list as string[]).push("+15551234567")).toThrow();
  });

  // A2: a malformed entry THROWS AT PARSE TIME — a typo must be a startup failure, never a
  // silently-shortened list. The message must NAME THE VARIABLE so the operator knows what
  // to fix without reading source.
  it.each([
    ["a national-format number", "09171112222"],
    ["a number with spaces", "+63 917 111 2222"],
    ["a number with dashes", "+63-917-111-2222"],
    ["a leading zero after +", "+0639171112222"],
    ["not a number at all", "ana@example.com"],
    ["a bare plus", "+"],
  ])("%s throws at parse time, naming SWITCHBOARD_PHONE_ALLOWLIST", (_label, entry) => {
    expect(() => parsePhoneAllowlist(entry)).toThrow(/SWITCHBOARD_PHONE_ALLOWLIST/);
    expect(() => parsePhoneAllowlist(`+639171112222,${entry}`)).toThrow(
      /SWITCHBOARD_PHONE_ALLOWLIST/,
    );
  });

  it("an empty ELEMENT is a typo, not an absence — it throws", () => {
    expect(() => parsePhoneAllowlist("+639171112222,,+639171112223")).toThrow(
      /SWITCHBOARD_PHONE_ALLOWLIST/,
    );
  });
});

describe("checkCallable — exact match only, empty list refuses everything (A1/A3/A4)", () => {
  const LIST = ["+639171112222"];

  // A1 (pure half): the empty allowlist refuses EVERY number, and the reason is actionable.
  // mutation (A1): make the empty-allowlist branch return { ok: true } -> red here AND in
  //   call-executor-allowlist.test.ts (run together).
  //   RUN ✅ 2026-08-19 — observed (with call-executor-allowlist.test.ts):
  //     Tests  3 failed | 27 passed (30)
  //     AssertionError: expected true to be false // Object.is equality
  //     AssertionError: promise resolved "{ …(5) }" instead of rejecting
  it("refuses every number against the empty allowlist, naming the variable", () => {
    const r = checkCallable("+639171112222", []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/SWITCHBOARD_PHONE_ALLOWLIST/);
  });

  it("whitespace-only allowlist entries do not count as entries", () => {
    const r = checkCallable("+639171112222", ["  ", ""]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/fail-closed/);
  });

  // A3 (pure half): listed proceeds; unlisted is refused AND the refusal names the number.
  // mutation (A3): make the not-on-the-list branch unreachable (`if (false)`) -> red.
  //   RUN ✅ 2026-08-19 — observed (with call-executor-allowlist.test.ts):
  //     Tests  8 failed | 22 passed (30)
  //     × a non-allowlisted number is refused, and the refusal names the number
  //     AssertionError: promise resolved "{ …(5) }" instead of rejecting
  it("an allowlisted number is callable", () => {
    expect(checkCallable("+639171112222", LIST)).toEqual({ ok: true });
  });

  it("a non-allowlisted number is refused, and the refusal names the number", () => {
    const r = checkCallable("+639998887777", LIST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("+639998887777");
  });

  // A4: NO prefix matching, NO wildcards, NO country-level allow.
  // mutation (A4): replace the exact `includes` with
  //   `permitted.some((p) => phoneE164.startsWith(p))` -> the prefix-shaped rows red.
  //   (The neighbour-digit rows stay green under startsWith — +…2222 is not a prefix of
  //   +…2223 — so the country-prefix and longer-number rows are the detectors here; the
  //   neighbour rows are detectors for a substring/looser mutation instead.)
  //   RUN ✅ 2026-08-19 — observed (with call-executor-allowlist.test.ts):
  //     Tests  4 failed | 26 passed (30)
  //     × a country prefix alone permits NOTHING
  //     × a listed number does not permit a longer number it prefixes
  //     × the payload number is never transformed to force a match
  //     × a country prefix on the list permits nothing  (executor half)
  it("a listed number does NOT permit its neighbour (+…2222 vs +…2223)", () => {
    const r = checkCallable("+639171112223", ["+639171112222"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("+639171112223");
  });

  it("a country prefix alone permits NOTHING", () => {
    const r = checkCallable("+639171112222", ["+63"]);
    expect(r.ok).toBe(false);
  });

  it("a listed number does not permit a longer number it prefixes", () => {
    const r = checkCallable("+6391711122220", ["+639171112222"]);
    expect(r.ok).toBe(false);
  });

  // The value that was approved is the value that is checked — no trimming, no
  // normalisation of the payload side. A payload number with stray whitespace is REFUSED,
  // never tidied into a match.
  it("the payload number is never transformed to force a match", () => {
    expect(checkCallable(" +639171112222", LIST).ok).toBe(false);
    expect(checkCallable("+639171112222 ", LIST).ok).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 639171112222],
    ["empty string", ""],
  ])("a payload number that is %s is refused, not thrown on", (_label, value) => {
    const r = checkCallable(value, LIST);
    expect(r.ok).toBe(false);
  });
});
