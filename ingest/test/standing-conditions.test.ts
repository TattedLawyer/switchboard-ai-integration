// Gate-H I3 and I4 — two operator lines that are true of the counters they read and
// false about the run they describe.
//
// Same family, stated once: a standing DISCLOSED condition (a terminal hydration dead
// letter) is invisible to the sentence printed beside it. Once on the backfill CLI,
// where "the object store was NOT contacted this cycle" prints one line above
// "HYDRATION DLQ: N dead-lettered this run"; once on the reconcile CLI, where the hub
// PASS line says "nothing pending" while N terminal dead letters stand — in a verdict
// block that already knows how to caveat itself, because acknowledged permanent gaps
// get exactly that treatment two lines above.
import { describe, expect, it } from "vitest";
import { storeNotContacted } from "../src/cli/backfill.js";
import { standingConditionsNote } from "../src/cli/reconcile.js";

describe("I3 — 'the object store was NOT contacted' must not print on a cycle that contacted it and failed", () => {
  it("is silent when everything is zero except the dead letters", () => {
    // A total object-store outage: every pending event is retried and dead-lettered in
    // the SAME run, so hydrated / tombstoned / hydrationPending are all 0 and the guard
    // fired — announcing that the store was never contacted, at the exact moment it was
    // contacted and failed every time.
    expect(storeNotContacted({ hydrated: 0, tombstoned: 0, hydrationPending: 0, hydrationDlq: 3 })).toBe(false);
  });

  it("still fires on the genuinely quiet cycle it exists for", () => {
    // The OPS-I5 case must survive: nothing awaiting hydration means the pump really did
    // not make a call, and a bare "hydrated 0" line reads as "I checked" when it is not.
    expect(storeNotContacted({ hydrated: 0, tombstoned: 0, hydrationPending: 0, hydrationDlq: 0 })).toBe(true);
  });

  it("stays silent whenever any other counter shows work", () => {
    expect(storeNotContacted({ hydrated: 1, tombstoned: 0, hydrationPending: 0, hydrationDlq: 0 })).toBe(false);
    expect(storeNotContacted({ hydrated: 0, tombstoned: 1, hydrationPending: 0, hydrationDlq: 0 })).toBe(false);
    expect(storeNotContacted({ hydrated: 0, tombstoned: 0, hydrationPending: 1, hydrationDlq: 0 })).toBe(false);
  });
});

describe("I4 — a PASS carrying standing disclosed conditions says so on the same line", () => {
  it("caveats a standing hydration DLQ, the way it already caveats acknowledged gaps", () => {
    const note = standingConditionsNote({ acknowledgedGaps: 0, hydrationDlq: 2 });
    expect(note).toContain("2");
    expect(note, "a terminal dead letter is a standing condition, not a clean bill of health").toMatch(
      /dead letter|DLQ/i,
    );
  });

  it("keeps the acknowledged-gap caveat exactly as it was", () => {
    expect(standingConditionsNote({ acknowledgedGaps: 3, hydrationDlq: 0 })).toContain(
      "3 acknowledged permanent gap(s) standing",
    );
  });

  it("names both when both stand, and neither when neither does", () => {
    const both = standingConditionsNote({ acknowledgedGaps: 1, hydrationDlq: 4 });
    expect(both).toContain("1 acknowledged permanent gap(s) standing");
    expect(both).toMatch(/4/);
    // Clean is clean: no parenthetical, so the ordinary PASS line is unchanged.
    expect(standingConditionsNote({ acknowledgedGaps: 0, hydrationDlq: 0 })).toBe("");
  });
});

// ── PRE-3 / #14 — a vanished mapped column is a STANDING CONDITION on the verdict ─────
//
// `standingConditionsNote` is the repo's existing convention for "the run is otherwise
// clean, and something disclosed and permanent still stands". Degradations are the same
// species — disclosed, operator-actionable, permanent until someone fixes the sheet — so
// they route through it rather than inventing a fourth convention, and they must NOT hard-
// red the run (the stripefeed-quarantine precedent: a permanent, disclosed condition must
// not red every reconcile forever).
describe("PRE-3 #14 — degradations join the standing-conditions note", () => {
  it("names the degraded column(s) on an otherwise clean run", () => {
    const note = standingConditionsNote({ acknowledgedGaps: 0, hydrationDlq: 0, degradations: ["amount", "status"] });
    expect(note).toContain("amount");
    expect(note).toContain("status");
    expect(note).toMatch(/degrad/i);
    // The existing shape is preserved: a parenthetical, pointing up at the detail.
    expect(note.startsWith(" (with ")).toBe(true);
    expect(note).toContain("see above");
  });

  it("stays silent when nothing stands — the ordinary PASS line is unchanged", () => {
    expect(standingConditionsNote({ acknowledgedGaps: 0, hydrationDlq: 0, degradations: [] })).toBe("");
  });

  it("composes with the two conditions that were already there, rather than replacing them", () => {
    const note = standingConditionsNote({ acknowledgedGaps: 2, hydrationDlq: 1, degradations: ["amount"] });
    expect(note).toContain("2 acknowledged permanent gap(s) standing");
    expect(note).toContain("1 terminal hydration dead letter(s) standing");
    expect(note).toContain("amount");
  });

  it("degradations is OPTIONAL — the callers that have no such concept are unaffected", () => {
    expect(standingConditionsNote({ acknowledgedGaps: 1, hydrationDlq: 0 })).toContain(
      "1 acknowledged permanent gap(s) standing",
    );
  });
});
