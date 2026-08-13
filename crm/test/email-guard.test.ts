// Email spike / Task 6 pins — `checkSendable`, the last thing between an approved payload
// and a real inbox.
//
// Pure, synchronous, no I/O, no clock — so the no-timer pin (Task 10) has a small surface
// and every case below is a table row rather than a fixture.
//
// 🚨 THE ALLOWLIST FAILS CLOSED. Unset, empty and whitespace-only all refuse EVERYTHING.
// The failure mode of a misconfigured allowlist must be "nothing was sent", never "it was
// sent to whoever was in the payload".
import { describe, it, expect } from "vitest";
import { checkSendable } from "../src/email-guard.js";

const ALLOW = ["ana@example.com"];
const ok = {
  contact_id: "00000000-0000-0000-0000-0000000000a1",
  to: "ana@example.com",
  subject: "Following up on the Alabang 2BR",
  body: "Hi Ana — still looking?",
};

describe("Task 6: checkSendable refuses what is not fit to send", () => {
  it("passes a clean payload to an allowlisted recipient", () => {
    expect(checkSendable(ok, ALLOW)).toEqual({ ok: true });
  });

  // ── Unrendered template placeholders ───────────────────────────────────────────────
  // mutation: loosen the placeholder regex to /\{\{\w+\}\}/ -> red. RUN ✅ 2026-08-12
  //   Observed: `Tests  2 failed | 19 passed (21)`
  //     × refuses a spaced double-brace placeholder
  //     × refuses a single-brace placeholder
  //   The two forms a naive regex misses are exactly the two a real template engine emits.
  it.each([
    ["a double-brace placeholder in the subject", { subject: "Hi {{name}}" }],
    ["a spaced double-brace placeholder", { subject: "Hi {{ name }}" }],
    ["a single-brace placeholder", { body: "Hi {name}, still looking?" }],
    ["a placeholder in the body", { body: "Hi {{first_name}}" }],
  ])("refuses %s", (_label, over) => {
    const r = checkSendable({ ...ok, ...over }, ALLOW);
    expect(r.ok).toBe(false);
  });

  // ── Stringified nothing ────────────────────────────────────────────────────────────
  // mutation: drop the `undefined`/`[object Object]` checks -> these red.
  it.each([
    ["the bare word undefined in the subject", { subject: "Re: undefined" }],
    ["the bare word undefined in the body", { body: "Your budget of undefined" }],
    ["[object Object]", { body: "Details: [object Object]" }],
  ])("refuses %s", (_label, over) => {
    expect(checkSendable({ ...ok, ...over }, ALLOW).ok).toBe(false);
  });

  // 🚨 An `undefined`-VALUED KEY, pinned as its own case. `render.ts:147`'s `in` guard lets
  // it through to the card, where `stableJson` renders it as the literal `null`. The guard
  // must refuse the payload rather than send a message the card described wrongly.
  // mutation: drop the undefined-value check (`if (v === undefined) continue;`) -> red.
  //           RUN ✅ 2026-08-12
  //   Observed: `Tests  1 failed | 20 passed (21)`
  //     AssertionError: expected 'subject contains stringified nothing'
  //                     to be 'subject is undefined'
  //
  // 🚨 THE REASON IS ASSERTED, NOT JUST THE REFUSAL. Measured: an `undefined` subject is
  // refused TWICE over — by the presence check ("subject is undefined") and, if that is
  // removed, by the stringified-nothing check, because `String(undefined)` is the literal
  // word "undefined". Defence in depth is welcome, but a pin that only asserts `ok === false`
  // is insensitive to its own named mechanism and stays GREEN while the check it exists to
  // guard is deleted. Asserting the reason is what makes the mutation red.
  it("refuses a payload carrying an undefined-valued key", () => {
    const r = checkSendable({ ...ok, subject: undefined }, ALLOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("subject is undefined");
  });

  // ── Header injection ───────────────────────────────────────────────────────────────
  // 🚨 THE ONE ATTACK THAT MAILS A STRANGER. `subject` is free text and header-bound.
  // Nodemailer does MIME-encode subjects, so exploitation is unlikely — and relying on an
  // undocumented vendor behaviour for this is exactly the dependency the allowlist exists
  // to remove. `to` is already refused by `.email()` (Task 5); re-checked here because
  // defence at the guard is the point. `body` is checked too, cheaply.
  //
  // mutation: narrow the CR/LF check to /\n/ only -> red. RUN ✅ 2026-08-12
  //   Observed: `Tests  2 failed | 19 passed (21)` — the bare-\r subject and body cases.
  // mutation: drop the CR/LF check entirely -> red. RUN ✅ 2026-08-12
  //   Observed: `Tests  5 failed | 16 passed (21)` — all three subject cases, the body
  //   case, and the reason-naming pin.
  //   NOTE, measured: the two `to` cases did NOT red under that second mutation. They are
  //   refused a second time by the allowlist (an address with a \r in it matches nothing).
  //   That is defence in depth working, and it is recorded rather than assumed — the
  //   subject cases are the ones carrying this pin.
  it.each([
    ["a CRLF Bcc in the subject", { subject: "Following up\r\nBcc: stranger@example.com" }],
    ["a bare LF in the subject", { subject: "Following up\nBcc: stranger@example.com" }],
    ["a bare CR in the subject", { subject: "Following up\rBcc: stranger@example.com" }],
    ["a CRLF in the recipient", { to: "ana@example.com\r\nBcc: stranger@example.com" }],
    ["a bare CR in the recipient", { to: "ana@example.com\rstranger@example.com" }],
    ["a bare CR in the body", { body: "Hi\rthere" }],
  ])("refuses %s", (_label, over) => {
    const r = checkSendable({ ...ok, ...over }, ALLOW);
    expect(r.ok).toBe(false);
  });

  // ── The allowlist ──────────────────────────────────────────────────────────────────
  it("refuses a recipient who is not on the allowlist", () => {
    const r = checkSendable({ ...ok, to: "stranger@example.com" }, ALLOW);
    expect(r.ok).toBe(false);
  });

  // mutation: make the empty allowlist permissive (`if (permitted.length === 0) return
  //           { ok: true };`) -> red. RUN ✅ 2026-08-12
  //   Observed: `Tests  2 failed | 19 passed (21)` — both fail-closed cases.
  //   NOTE, measured: merely DELETING the empty-list early return does NOT red, because the
  //   subsequent `includes` refuses an empty list anyway. The mutation that isolates this
  //   property is the one that makes it PERMISSIVE, and that is the one that was run.
  it.each([
    ["an empty allowlist", [] as string[]],
    ["an allowlist of only whitespace entries", ["   "]],
  ])("refuses everything given %s (fail-closed)", (_label, allow) => {
    expect(checkSendable(ok, allow).ok).toBe(false);
  });

  it("matches the allowlist case-insensitively on the FULL address", () => {
    expect(checkSendable({ ...ok, to: "ana@example.com" }, ["ANA@EXAMPLE.COM"]).ok).toBe(true);
  });

  // 🚨 NO DOMAIN WILDCARDS. A wildcard is how an allowlist stops being one.
  it("does not treat an allowlisted address as permission for its domain", () => {
    expect(checkSendable({ ...ok, to: "bob@example.com" }, ALLOW).ok).toBe(false);
  });

  // ── The reason names the offending field ───────────────────────────────────────────
  it("names the offending field in every refusal reason", () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ subject: "Hi {{name}}" }, /subject/i],
      [{ body: "Hi {{name}}" }, /body/i],
      [{ subject: "a\r\nb" }, /subject/i],
      [{ to: "stranger@example.com" }, /(to|recipient|allowlist)/i],
    ];
    for (const [over, re] of cases) {
      const r = checkSendable({ ...ok, ...over }, ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(re);
    }
  });
});
