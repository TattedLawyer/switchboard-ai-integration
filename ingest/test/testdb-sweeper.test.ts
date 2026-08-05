// PRE-3 / #22 (gate-H M11, hygiene) — nothing reclaims leaked ephemeral databases.
//
// `helpers/testdb.ts` has a careful, idempotent, termination-proof `cleanup()`, but a
// SIGKILLed run never reaches it, so `switchboard_test_<ms>_<rand>` databases accumulate
// on a dev instance. Three were standing when the entry was filed; three more were
// standing on the instance this wave started on.
//
// A sweeper that drops databases is its own foot-gun, and that is the whole reason this
// file leads with the refusals rather than the drops. The predicate must satisfy BOTH
// conditions — the exact minted name shape AND an age past the threshold — and must
// refuse anything else without needing to know what it is. In particular it must refuse
// the named `switchboard` database, which a concurrent session may own, and it must
// refuse a name that merely LOOKS adjacent (`switchboard_test`, `switchboard_testing`,
// `switchboard_scratch`) rather than guessing.
//
// Age comes from the name, not the catalog: `freshTestDb` mints
// `switchboard_test_${Date.now()}_${rand}`, so the timestamp is already carried by the
// only databases the sweeper is allowed to touch. A name whose timestamp cannot be parsed
// is therefore not one of ours, and is refused for that reason rather than swept on a
// guess.
import { describe, expect, it } from "vitest";
import { shouldSweep, STALE_TEST_DB_AGE_MS } from "./helpers/sweep-test-dbs.js";

const NOW = 1_800_000_000_000;
const old = NOW - STALE_TEST_DB_AGE_MS - 1;
const fresh = NOW - 1_000;

describe("PRE-3 #22 — the sweeper's predicate refuses far more than it accepts", () => {
  it("sweeps a minted ephemeral database that is past the age threshold", () => {
    expect(shouldSweep(`switchboard_test_${old}_a1b2c3`, NOW)).toBe(true);
  });

  it("REFUSES a minted database that is still young — a live parallel run must never be dropped", () => {
    expect(shouldSweep(`switchboard_test_${fresh}_a1b2c3`, NOW)).toBe(false);
    // Exactly at the threshold is still young: the boundary is a strict `older than`.
    expect(shouldSweep(`switchboard_test_${NOW - STALE_TEST_DB_AGE_MS}_a1b2c3`, NOW)).toBe(false);
  });

  it("REFUSES the named switchboard database and everything adjacent to it, unconditionally", () => {
    for (const name of [
      "switchboard",
      "switchboard_pre3_scratch",
      "postgres",
      "template0",
      "template1",
      "switchboard_test", // the prefix alone is not a minted name
      "switchboard_testing",
      "switchboard_test_",
      `switchboard_test_${old}`, // no random suffix — not the shape freshTestDb mints
      `xswitchboard_test_${old}_a1b2c3`, // not anchored at the start
      `switchboard_test_${old}_a1b2c3_extra`, // not anchored at the end
    ]) {
      expect(shouldSweep(name, NOW), name).toBe(false);
    }
  });

  it("REFUSES a name whose timestamp cannot be read as one — an unparseable age is not an old age", () => {
    expect(shouldSweep("switchboard_test_notatimestamp_a1b2c3", NOW)).toBe(false);
    // A future timestamp is a clock anomaly, not a stale database.
    expect(shouldSweep(`switchboard_test_${NOW + 60_000}_a1b2c3`, NOW)).toBe(false);
  });

  it("the threshold is long enough that the slowest suite in this repo cannot outlive it", () => {
    // ingest/vitest.config.ts sets hookTimeout to 120s and testTimeout to 30s; the full
    // ingest suite runs well under 5 minutes. An hour is two orders of magnitude of
    // headroom, which is the correct posture for an operation that drops databases.
    expect(STALE_TEST_DB_AGE_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });
});
