// The dbt green criterion is "ERROR=0 and the warn set is EXACTLY the F7 demonstration
// row" — but dbt exits 0 on warnings, so nothing in CI could tell one warn from two.
// `assert_unusable_amounts_flagged` is warn-severity and currently 0 rows; the day it
// fires, the build stays green and the new signal hides behind the expected one.
//
// These pins fix the criterion as data and prove the check discriminates in BOTH
// directions (an extra warn, and the expected warn going missing) plus refuses to
// report success over an artifact it couldn't read. The live artifact is checked by
// scripts/verify-dbt-warns.ts in the ci.yml dbt leg; this suite pins its logic against
// synthesized run_results documents so the discrimination is proven without a warehouse.
import { describe, expect, it } from "vitest";
import { EXPECTED_DBT_WARNS, checkWarnSet } from "../../scripts/dbt-warn-contract.js";

type Res = { unique_id: string; status: string; failures: number | null };

const pass = (name: string): Res => ({ unique_id: `test.switchboard.${name}.abc123`, status: "pass", failures: 0 });
const warn = (name: string, failures: number): Res => ({ unique_id: `test.switchboard.${name}.abc123`, status: "warn", failures });
const doc = (results: Res[]) => ({ args: { which: "build" }, results });

/** The shape a green CI `dbt build` actually produces at head. */
const GREEN = doc([
  { unique_id: "model.switchboard.customer_360", status: "success", failures: null },
  pass("assert_amounts_non_negative"),
  pass("assert_unusable_amounts_flagged"),
  warn("assert_amounts_plausible", 1),
]);

describe("dbt expected-warn contract", () => {
  it("pins the F7 demonstration warn as the ONLY permitted warn", () => {
    expect(EXPECTED_DBT_WARNS).toEqual({ assert_amounts_plausible: 1 });
  });

  it("accepts the green build: exactly the expected warn, everything else passing", () => {
    expect(checkWarnSet(GREEN)).toEqual([]);
  });

  // THE masking case this whole contract exists for.
  it("catches a SECOND warn-severity test hiding behind the expected one", () => {
    const masked = doc(
      GREEN.results.map((r) => (r.unique_id.includes("unusable") ? warn("assert_unusable_amounts_flagged", 3) : r)),
    );
    const failures = checkWarnSet(masked);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("UNEXPECTED WARN: assert_unusable_amounts_flagged");
    expect(failures[0]).toContain("3 row(s)");
  });

  it("catches the expected warn going MISSING — F7 decaying back to vacuous", () => {
    const vacuous = doc(GREEN.results.map((r) => (r.status === "warn" ? pass("assert_amounts_plausible") : r)));
    expect(checkWarnSet(vacuous)).toEqual([
      expect.stringContaining("expected WARN from assert_amounts_plausible"),
    ]);
  });

  it("catches the expected warn surfacing a DIFFERENT number of rows", () => {
    const two = doc(GREEN.results.map((r) => (r.status === "warn" ? warn("assert_amounts_plausible", 2) : r)));
    expect(checkWarnSet(two)).toEqual([
      "assert_amounts_plausible: expected 1 warning row(s), got 2",
    ]);
  });

  it("reports an error-status node rather than reading only the warn set", () => {
    const broken = doc([...GREEN.results, { unique_id: "test.switchboard.assert_csat_in_scale.x", status: "fail", failures: 4 }]);
    expect(checkWarnSet(broken)).toEqual([expect.stringContaining("status fail")]);
  });

  // A verifier that can't read its artifact must never report success.
  it("refuses to pass over an empty, malformed, or non-build artifact", () => {
    expect(checkWarnSet(doc([]))).toEqual([expect.stringContaining("empty")]);
    expect(checkWarnSet({ args: { which: "build" } })).toEqual([expect.stringContaining("not an array")]);
    expect(checkWarnSet(null)).toEqual([expect.stringContaining("not an object")]);
    expect(checkWarnSet({ args: { which: "test" }, results: GREEN.results })).toEqual([
      expect.stringContaining("not `dbt build`"),
    ]);
  });
});
