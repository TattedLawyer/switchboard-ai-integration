// Core loop / T8 pins — the `place_call` payload grammar.
//
// These live in the approval workspace because the grammar does: `PROPOSAL_ACTION_TYPES` is
// the allowlist the door enforces, and a payload schema kept anywhere else would be a
// second grammar for the same door.
import { describe, it, expect } from "vitest";
import {
  PROPOSAL_ACTION_TYPES,
  placeCallPayloadSchema,
  followUpEmailPayloadSchema,
} from "../src/proposal.js";

const NAMED = {
  contact_id: "11111111-1111-1111-1111-111111111111",
  phone_number_id: "22222222-2222-2222-2222-222222222222",
  phone_e164: "+639171234567",
  display_name: "Ana Reyes",
  opening_line:
    "Hi, this is Marisol's assistant from Alabang Realty. May I speak with Ana Reyes?",
  question_set_id: "33333333-3333-3333-3333-333333333333",
  context: { source_detail: "Rotary breakfast", looking_for: "a 2BR near Alabang" },
};

const NAMELESS = {
  ...NAMED,
  display_name: null,
  opening_line: "Hi, I'm an associate of Marisol Cruz at Alabang Realty — do you have a moment?",
};

describe("T8: place_call is on the allowlist", () => {
  it("is a member, and the allowlist is still an allowlist", () => {
    expect(PROPOSAL_ACTION_TYPES).toContain("place_call");
    expect(PROPOSAL_ACTION_TYPES).toContain("send_email");
    expect(PROPOSAL_ACTION_TYPES).toHaveLength(2);
  });
});

describe("T8: an unknown field is a REFUSAL, not a silent drop", () => {
  // mutation: remove `.strict()` from `placeCallPayloadSchema` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 7 passed (8)`
  //     AssertionError: expected true to be false // Object.is equality
  //   A dropped field is a field the human approved and the executor acts on unseen.
  it("refuses an extra key", () => {
    const r = placeCallPayloadSchema.safeParse({ ...NAMED, second_number: "+639179999999" });
    expect(r.success).toBe(false);
  });

  // mutation: `phone_e164: z.array(z.string())` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  3 failed | 5 passed (8)` — three, because every fixture in this
  //   file names one number:
  //     AssertionError: expected false to be true   (x3; the single-number payloads, named
  //                     and nameless alike, are all refused once the field wants an array)
  //   §5.1 at the schema level: an approved proposal names ONE number in an immutable
  //   payload, so dialling a second mid-execution places a call to a number THE HUMAN NEVER
  //   APPROVED. The list rotates ACROSS cycles, not within one.
  it("names exactly one phone_e164, never an array", () => {
    expect(placeCallPayloadSchema.safeParse(NAMED).success).toBe(true);
    expect(
      placeCallPayloadSchema.safeParse({
        ...NAMED,
        phone_e164: ["+639171234567", "+639179999999"],
      }).success,
    ).toBe(false);
  });
});

describe("T8: the fields without which a call is unreproducible", () => {
  // mutation: `question_set_id: z.string().uuid().optional()` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 7 passed (8)`
  //     AssertionError: expected true to be false
  //   Nothing afterwards could say what the prospect was actually asked.
  it("refuses a payload with no question_set_id", () => {
    const { question_set_id: _omitted, ...without } = NAMED;
    expect(placeCallPayloadSchema.safeParse(without).success).toBe(false);
  });

  // mutation: `opening_line: z.string().optional()` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 7 passed (8)`
  //     AssertionError: expected true to be false
  //   Settled owner control: the first sentence is hers.
  it("refuses a payload with no opening_line", () => {
    const { opening_line: _omitted, ...without } = NAMED;
    expect(placeCallPayloadSchema.safeParse(without).success).toBe(false);
  });
});

describe("T8 / I-1: the NAMED and NAMELESS variants, split deliberately", () => {
  // NAMED — the RENDERING half of this pin lives in `crm/test/opening.test.ts`, against
  // `renderOpening`, because that is the function a "bind the raw template instead" edit
  // would actually be made in. Here we pin only that the shape validates.
  it("validates a named payload", () => {
    expect(placeCallPayloadSchema.safeParse(NAMED).success).toBe(true);
    expect(NAMED.opening_line).toContain("Ana Reyes");
    expect(NAMED.opening_line).not.toContain("{name}");
  });

  // 🚨 NAMELESS — the cheapest way this design could have died silently.
  // mutation: `display_name: z.string()` instead of `z.string().nullable()` -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 7 passed (8)`
  //     AssertionError: expected false to be true
  //     (zod issue: invalid_type — expected string, received null, at display_name)
  //   EVERY NAMELESS PROPOSAL WOULD BE REFUSED AT VALIDATION and the owner's rev-4 decision
  //   would be dead on arrival, with nothing else in the suite noticing.
  it("validates a payload whose display_name is null", () => {
    const r = placeCallPayloadSchema.safeParse(NAMELESS);
    expect(r.success).toBe(true);
    expect(NAMELESS.opening_line).not.toContain("{name}");
    expect(NAMELESS.opening_line).toContain("associate");
  });
});

describe("T8: the follow-up email payload", () => {
  it("is strict too", () => {
    const ok = {
      contact_id: "11111111-1111-1111-1111-111111111111",
      to: "ana@example.com",
      subject: "Following up",
      body: "Hi Ana — checking in on the Alabang search.",
    };
    expect(followUpEmailPayloadSchema.safeParse(ok).success).toBe(true);
    expect(followUpEmailPayloadSchema.safeParse({ ...ok, bcc: "x@y.z" }).success).toBe(false);
  });
});
