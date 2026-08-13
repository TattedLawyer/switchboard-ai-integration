// Email spike / Task 5 pins — `followUpEmailPayloadSchema` stops being dead code.
//
// 🚨 THIS SCHEMA MUST NEVER MUTATE THE VALUE. No `.trim()`, no `.toLowerCase()`, no
// `.transform()`, no coercion — here or anywhere on the send path. `parsePayload` must
// return the recipient that is stored in `approval.proposals.payload`, covered by
// `payload_hash`, and rendered on the card the human approved. A transform of one character
// dissolves the card↔envelope byte identity the acceptance criterion rests on: a trailing
// space renders visibly on the card and vanishes in the envelope, silently.
//
// So every rule below is a REFUSAL, and the last pin asserts the identity directly.
// Refusing is recoverable. Normalising is not.
import { describe, it, expect } from "vitest";
import { followUpEmailPayloadSchema } from "../src/proposal.js";

const base = {
  contact_id: "00000000-0000-0000-0000-0000000000a1",
  to: "ana@example.com",
  subject: "Following up on the Alabang 2BR",
  body: "Hi Ana — still looking?",
};

const parse = (over: Record<string, unknown>) =>
  followUpEmailPayloadSchema.safeParse({ ...base, ...over });

describe("Task 5: the follow-up email recipient must look like an address", () => {
  it("accepts a plain address", () => {
    const r = parse({});
    expect(r.success).toBe(true);
  });

  // mutation: restore `to: z.string().min(1)` -> red. RUN ✅ 2026-08-12
  //   Observed: `Tests  9 failed | 5 passed (14)` — every case below except the empty
  //   string, each `AssertionError: expected true to be false`. "ana" was accepted as a
  //   recipient; so was "ana@example.com, bob@example.com".
  it.each([
    ["no domain at all", "ana"],
    ["a bare @", "ana@"],
    ["an embedded space", "a b@c.d"],
    ["a leading space", " ana@example.com"],
    ["a trailing space", "ana@example.com "],
    ["a smuggled second recipient", "ana@example.com, bob@example.com"],
    ["display-name form", "Ana <ana@example.com>"],
    ["a newline", "ana@example.com\nBcc: stranger@example.com"],
    ["a carriage return", "ana@example.com\rBcc: stranger@example.com"],
    ["empty", ""],
  ])("refuses %s", (_label, to) => {
    expect(parse({ to }).success).toBe(false);
  });

  // 🚨 THE ANTI-TRANSFORM PIN. If a `.trim()` (or any other transform) is ever added, this
  // is the assertion that catches it — the parsed value must be the SAME BYTES that went in.
  // mutation: add `.trim()` to the `to` schema -> red. RUN ✅ 2026-08-12
  //   Observed: `Tests  2 failed | 12 passed (14)`
  //     × refuses a leading space   AssertionError: expected true to be false
  //     × refuses a trailing space  AssertionError: expected true to be false
  //   i.e. `.trim()` ACCEPTS " ana@example.com" and returns "ana@example.com" — the sent
  //   address would differ from the stored, hashed and rendered one. Measured, not reasoned.
  it("returns the recipient byte-for-byte as approved, never normalised", () => {
    for (const to of ["ana@example.com", "Ana.Reyes@Example.COM", "a+tag@mail.example.com"]) {
      const r = parse({ to });
      expect(r.success, `${to} should parse`).toBe(true);
      if (r.success) expect(r.data.to).toBe(to);
    }
  });

  it("refuses an empty subject and an empty body", () => {
    expect(parse({ subject: "" }).success).toBe(false);
    expect(parse({ body: "" }).success).toBe(false);
  });

  // Regression lock on `.strict()` — already true, and it is what makes the `cc` key that
  // `render.ts:64-70` can DISPLAY unconstructible on the send path. No second recipient can
  // be smuggled through a key the schema never admitted.
  it("refuses an unknown key", () => {
    expect(parse({ cc: "stranger@example.com" }).success).toBe(false);
  });
});
