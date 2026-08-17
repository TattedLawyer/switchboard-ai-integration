// Pins for crm/src/sheet-columns.ts — the contact-shaped column mapper. Pure: no DB.
import { describe, it, expect } from "vitest";
import {
  resolveContactColumns,
  contactRowFields,
  isSheetRefusal,
  CONTACT_COLUMN_MAP,
  type ContactColumnMap,
  type ContactHeaderMapping,
} from "../src/sheet-columns.js";
import { renderOpening } from "../src/opening.js";

/** Resolve and assert it did not refuse — most pins start from a mappable sheet. */
function mustResolve(header: readonly string[], map?: ContactColumnMap): ContactHeaderMapping {
  const r = resolveContactColumns(header, map);
  expect(isSheetRefusal(r)).toBe(false);
  if (isSheetRefusal(r)) throw new Error(r.error);
  return r;
}

describe("header resolution is by NAME, never a cached position", () => {
  // mutation: module-level cache (`let MUTATION_CACHE; if (MUTATION_CACHE) return
  // MUTATION_CACHE;` + `return (MUTATION_CACHE = {...})`) -> red. RUN ✅ 2026-08-17
  //   Observed: `Tests  11 failed | 6 passed (17)` — this pin:
  //     AssertionError: expected undefined to be +0 // Object.is equality
  //       ("re-resolving after a column insert finds the moved columns" —
  //        after.positions.source_detail is stale-undefined)
  //   plus 10 downstream pins red on the stale first resolution (phones [],
  //   collision pins, order pins) — a cached mapping poisons everything after it.
  it("re-resolving after a column insert finds the moved columns", () => {
    const before = mustResolve(["Name", "Email", "Phone"]);
    expect(before.positions.display_name).toBe(0);
    expect(before.positions.email).toBe(1);
    expect(before.phoneColumns).toEqual([2]);

    // Her real-world edit: a column inserted at the left. Same names, new positions.
    const after = mustResolve(["Met At", "Name", "Email", "Phone"]);
    expect(after.positions.source_detail).toBe(0);
    expect(after.positions.display_name).toBe(1);
    expect(after.positions.email).toBe(2);
    expect(after.phoneColumns).toEqual([3]);
  });
});

describe("alias matching is case- and whitespace-insensitive", () => {
  // mutation: drop `.trim().toLowerCase()` from header normalization -> red.
  //           RUN ✅ 2026-08-17
  //   Observed: `Tests  16 failed | 1 passed (17)` — this pin:
  //     AssertionError: expected true to be false // Object.is equality
  //       (the "  NAME  " sheet now REFUSES: nothing matches, so mustResolve reds)
  //   15 other pins red too — every fixture uses her capitalised headers, which is
  //   the point: real sheets are never lowercase.
  it("maps '  NAME  ', 'E-Mail', 'CONTACT #' despite case and padding", () => {
    const m = mustResolve(["  NAME  ", "E-Mail", "CONTACT #"]);
    expect(m.positions.display_name).toBe(0);
    expect(m.positions.email).toBe(1);
    expect(m.phoneColumns).toEqual([2]);
  });
});

describe("first-claim-wins on a collision (a column serves at most one field)", () => {
  // mutation A: remove both `!claimed.has(i)` guards so a later field re-claims a
  // column -> red. RUN ✅ 2026-08-17
  //   Observed: `Tests  1 failed | 16 passed (17)` —
  //     AssertionError: expected 1 to be undefined
  //       ("shared alias…": notes double-feeds from the source_detail column)
  // mutation B: remove the `break` so the LAST matching column wins instead of the
  // first -> red. RUN ✅ 2026-08-17
  //   Observed: `Tests  1 failed | 16 passed (17)` —
  //     AssertionError: expected 2 to be +0 // Object.is equality
  //       ("second 'Name' column…": display_name jumped to the rightmost duplicate)
  it("second 'Name' column stays unclaimed rather than double-feeding display_name", () => {
    const m = mustResolve(["Name", "Phone", "Name"]);
    expect(m.positions.display_name).toBe(0);
    expect(m.phoneColumns).toEqual([1]);
  });

  it("shared alias across two fields: first field in map order wins, the later field degrades to missing", () => {
    const map: ContactColumnMap = { ...CONTACT_COLUMN_MAP, notes: ["met at", "notes"] };
    // "met at" is an alias of source_detail (earlier in map order) AND of notes here.
    const m = mustResolve(["Name", "Met At"], map);
    expect(m.positions.source_detail).toBe(1);
    expect(m.positions.notes).toBeUndefined();
    expect(m.missing).toContain("notes");
  });
});

describe("phone claims MULTIPLE columns, in sheet order — dial order is entry order", () => {
  // mutation: `phoneColumns.push(i)` -> `phoneColumns.unshift(i)` (reverse order) -> red.
  //           RUN ✅ 2026-08-17
  //   Observed: `Tests  2 failed | 15 passed (17)` —
  //     AssertionError: expected [ 3, +0 ] to deeply equal [ +0, 3 ]
  //     AssertionError: expected [ '+639181234567', '+639171234567' ] to deeply equal
  //                     [ '+639171234567', '+639181234567' ]
  it("collects every phone-ish column left to right", () => {
    const m = mustResolve(["Phone", "Name", "Email", "Mobile 2"]);
    expect(m.phoneColumns).toEqual([0, 3]);
  });

  it("row phones come out in sheet order across columns", () => {
    const m = mustResolve(["Phone", "Name", "Email", "Mobile 2"]);
    const row = contactRowFields(m, ["0917-123-4567", "Maria", "m@x.ph", "0918-123-4567"]);
    expect(row.phones.map((p) => p.e164)).toEqual(["+639171234567", "+639181234567"]);
    expect(row.phoneProblems).toEqual([]);
  });
});

describe("multiple numbers inside ONE cell", () => {
  // mutation: after splitting, keep only the first segment (`.slice(0, 1)`) -> red.
  //           RUN ✅ 2026-08-17
  //   Observed: `Tests  2 failed | 15 passed (17)` —
  //     AssertionError: expected [ '+639171234567' ] to deeply equal
  //                     [ '+639171234567', '+639181234567' ]
  //     (also reds the junk-segment pin: expected +0 to be 1 — the dropped second
  //      segment was the unreadable one)
  it("splits '0917-123-4567 / 0918-123-4567' into two numbers, in-cell order kept", () => {
    const m = mustResolve(["Name", "Contact #"]);
    const row = contactRowFields(m, ["Maria", "0917-123-4567 / 0918-123-4567"]);
    expect(row.phones.map((p) => p.e164)).toEqual(["+639171234567", "+639181234567"]);
  });

  it("does NOT split on hyphens or inner spaces — those live inside numbers", () => {
    const m = mustResolve(["Name", "Contact #"]);
    const row = contactRowFields(m, ["Maria", "+63 917 123 4567"]);
    expect(row.phones.map((p) => p.e164)).toEqual(["+639171234567"]);
    expect(row.phoneProblems).toEqual([]);
  });
});

describe("an unreadable number SURFACES as a per-row problem — never guessed, never dropped", () => {
  // mutation: in the isPhoneError branch, drop the `phoneProblems.push(...)` (silent
  // skip) -> red. RUN ✅ 2026-08-17
  //   Observed: `Tests  2 failed | 15 passed (17)` —
  //     AssertionError: expected +0 to be 1 // Object.is equality  (twice — both pins:
  //       row.phoneProblems.length; the junk segment vanished without a trace)
  it("junk segment lands in phoneProblems with the raw text and phone.ts's error", () => {
    const m = mustResolve(["Name", "Phone"]);
    const row = contactRowFields(m, ["Maria", "0917-123-4567 / call after 6pm"]);
    expect(row.phones.map((p) => p.e164)).toEqual(["+639171234567"]);
    expect(row.phoneProblems.length).toBe(1);
    expect(row.phoneProblems[0].raw).toBe("call after 6pm");
    expect(row.phoneProblems[0].error).toContain("call after 6pm");
  });

  it("a problem row is still a row — fields around the bad number are kept", () => {
    const m = mustResolve(["Name", "Phone"]);
    const row = contactRowFields(m, ["Maria", "not a number at all"]);
    expect(row.displayName).toBe("Maria");
    expect(row.phones).toEqual([]);
    expect(row.phoneProblems.length).toBe(1);
  });
});

describe('"" → null at the boundary — the opening.ts nameless path depends on it', () => {
  // mutation: `blankToNull` returns the raw cell (`cell ?? null`) instead of
  // normalizing -> red. RUN ✅ 2026-08-17
  //   Observed: `Tests  4 failed | 13 passed (17)` —
  //     AssertionError: expected '' to be null   (×3, across the text-field pins)
  //     AssertionError: expected 'named' to be 'nameless' // Object.is equality
  //       — the exact reviewed bug: "" reaches renderOpening, the NAMED path fires
  //       ("Hi , this is…" would be spoken) and identityUnverified stays false.
  it("empty and whitespace-only name cells become null", () => {
    const m = mustResolve(["Name", "Email"]);
    expect(contactRowFields(m, ["", "m@x.ph"]).displayName).toBeNull();
    expect(contactRowFields(m, ["   ", "m@x.ph"]).displayName).toBeNull();
    // Short row: the name column simply absent from the cells array.
    expect(contactRowFields(m, []).displayName).toBeNull();
  });

  it("an empty name cell therefore reaches renderOpening's NAMELESS path, flagged unverified", () => {
    const m = mustResolve(["Name", "Phone"]);
    const row = contactRowFields(m, ["  ", "0917-123-4567"]);
    const opening = renderOpening(row.displayName, {
      openingLine: "Hi {name}, this is Ana.",
      openingLineNoName: "This is Ana, an associate…",
    });
    expect(opening.path).toBe("nameless");
    expect(opening.identityUnverified).toBe(true);
    expect(opening.line).toBe("This is Ana, an associate…");
  });

  it("other text fields get the same normalization", () => {
    const m = mustResolve(["Name", "Met At", "Notes"]);
    const row = contactRowFields(m, ["Maria", "", "  "]);
    expect(row.sourceDetail).toBeNull();
    expect(row.notes).toBeNull();
  });
});

describe("sheet-level refusal: ONLY when none of {display_name, email, phone} map", () => {
  // mutation A: refuse like ingest does (`display_name === undefined || email ===
  // undefined`) -> red. RUN ✅ 2026-08-17
  //   Observed: `Tests  10 failed | 7 passed (17)` —
  //     AssertionError: expected true to be false // Object.is equality
  //       ("a sheet with ONLY a phone column is accepted" and "…ONLY a name column…" —
  //        the ingest-strict rule refuses exactly the contact lists intake exists to
  //        keep; 8 other fixtures without an email column red with them)
  // mutation B: never refuse (`false && …`) -> red. RUN ✅ 2026-08-17
  //   Observed: `Tests  1 failed | 16 passed (17)` —
  //     AssertionError: expected false to be true // Object.is equality
  //       ("a sheet with none of the three refuses LOUDLY, naming the headers it saw")
  it("a sheet with none of the three refuses LOUDLY, naming the headers it saw", () => {
    const r = resolveContactColumns(["Deal", "Amount", "Stage"]);
    expect(isSheetRefusal(r)).toBe(true);
    if (!isSheetRefusal(r)) return;
    expect(r.error).toContain("Deal");
    expect(r.error).toContain("Amount");
    expect(r.error).toContain("Stage");
    expect(r.headersSeen).toEqual(["Deal", "Amount", "Stage"]);
  });

  it("a sheet with ONLY a phone column is accepted", () => {
    const m = mustResolve(["Contact #"]);
    expect(m.phoneColumns).toEqual([0]);
    // The un-mappable fields are degradations, not refusals.
    expect(m.missing).toContain("display_name");
    expect(m.missing).toContain("email");
  });

  it("a sheet with ONLY a name column is accepted", () => {
    const m = mustResolve(["Full Name"]);
    expect(m.positions.display_name).toBe(0);
  });

  it("a ROW with no email and no phone is still a row — per-row gaps are downstream's job", () => {
    const m = mustResolve(["Name", "Email", "Phone"]);
    const row = contactRowFields(m, ["Maria", "", ""]);
    expect(row.displayName).toBe("Maria");
    expect(row.emailAddress).toBeNull();
    expect(row.phones).toEqual([]);
    expect(row.phoneProblems).toEqual([]);
  });
});
