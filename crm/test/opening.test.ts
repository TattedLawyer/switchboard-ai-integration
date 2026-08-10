// Core loop / T8+I-1 pins — the sentence the agent says first.
import { describe, it, expect } from "vitest";
import { renderOpening } from "../src/opening.js";

const LINES = {
  openingLine:
    "Hi, this is Marisol's assistant from Alabang Realty. May I speak with {name}?",
  openingLineNoName:
    "Hi, I'm an associate of Marisol Cruz at Alabang Realty — do you have a moment?",
};

describe("T8 / I-1: the NAMED path", () => {
  // mutation: bind the raw template instead of the substituted line —
  //           `line: lines.openingLine` with no `.replaceAll` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 2 passed (3)`
  //     AssertionError: expected 'Hi, this is Marisol\'s assistant from…' to contain
  //                     'Ana Reyes'   — i.e. the payload carries the live template.
  //
  // She must approve THE EXACT WORDS THAT WILL BE SPOKEN; 015:353-363 then makes them
  // unchangeable. A payload carrying a live `{name}` means the card showed her a template
  // and the call says something she never read.
  it("renders the name in and leaves no placeholder behind", () => {
    const r = renderOpening("Ana Reyes", LINES);
    expect(r.path).toBe("named");
    expect(r.line).toContain("Ana Reyes");
    expect(r.line).not.toContain("{name}");
    expect(r.identityUnverified).toBe(false);
  });
});

describe("T8 / I-1: the NAMELESS path", () => {
  // mutation: render the nameless path from `opening_line` — `renderOpening` ignoring the
  //           null and substituting into her NAMED line -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 2 passed (3)`
  //     AssertionError: expected 'Hi, this is Marisol\'s assistant from…' to be
  //                     'Hi, I\'m an associate of Marisol Cruz…'
  //
  // Owner, rev 4: "if the number has no name just introduce yourself as an associate of the
  // end user." Rendering from the named line here produces either a leftover `{name}` or
  // the word "null" spoken to a referral lead.
  it("uses her nameless line, verbatim, and labels the touch identity-unverified", () => {
    const r = renderOpening(null, LINES);
    expect(r.path).toBe("nameless");
    expect(r.line).toBe(LINES.openingLineNoName);
    expect(r.line).not.toContain("{name}");
    expect(r.line).not.toContain("null");
    // 🚨 A DATA-QUALITY FACT, NOT A DISPOSITION. `wrong_person` is a different claim and
    // 016's CHECK makes the two unrepresentable together.
    expect(r.identityUnverified).toBe(true);
  });

  it("keys on `is null`, never on the empty string", () => {
    // The column is nullable; an empty-string name is not the nameless path and must not
    // silently become one.
    const r = renderOpening("", LINES);
    expect(r.path).toBe("named");
  });
});
