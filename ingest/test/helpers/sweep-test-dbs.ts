// PRE-3 (#22): reclaim ephemeral test databases a SIGKILLed run left behind.
//
// `freshTestDb()` mints `switchboard_test_${Date.now()}_${rand}` and drops it in a
// cleanup that is idempotent and termination-proof — but a run that dies before cleanup
// leaves the database standing forever, and nothing reclaims it. It is a recurring dev
// instance tax, not a correctness problem, which is why the sweeper is deliberately the
// most timid piece of code in the repo.
//
// THE FOOT-GUN, AND THE ANSWER. Something that drops databases in a loop must be wrong in
// only one direction. So the predicate below is a conjunction of two independent
// conditions, and anything that fails either is left alone without the sweeper needing to
// know what it is:
//
//   1. the name matches the EXACT shape `freshTestDb` mints, anchored at both ends —
//      not a prefix test. `switchboard`, `switchboard_test`, `switchboard_testing` and
//      any scratch database therefore cannot match, whatever else is true.
//   2. the timestamp embedded in that name is older than STALE_TEST_DB_AGE_MS.
//
// Age comes from the name rather than the catalog on purpose: the only databases this may
// touch are precisely the ones whose names already carry `Date.now()`, so a name whose
// timestamp will not parse is proof it was not minted here — a refusal, never a guess. A
// FUTURE timestamp is a clock anomaly rather than a stale database, and is also refused.

/** One hour. The full ingest suite runs in well under five minutes and its longest
 *  configured hook budget is 120s, so this is two orders of magnitude of headroom — the
 *  right posture for an operation that drops databases. A parallel run in progress can
 *  never be old enough to qualify. */
export const STALE_TEST_DB_AGE_MS = 60 * 60 * 1000;

/** The exact shape `freshTestDb()` mints, anchored at BOTH ends.
 *  `Math.random().toString(36).substring(7)` yields 5–6 lowercase alphanumerics; the
 *  bound is deliberately generous rather than exact, because tightening it would make the
 *  sweeper silently stop working, while loosening it cannot reach a non-minted name — the
 *  `switchboard_test_<digits>_` prefix is not a shape anything else in this repo uses. */
const MINTED = /^switchboard_test_(\d{10,})_([a-z0-9]{1,12})$/;

/** True only for a database this repo minted AND abandoned. False for everything else,
 *  including every name it does not recognise. */
export function shouldSweep(name: string, nowMs: number = Date.now()): boolean {
  const m = MINTED.exec(name);
  if (m === null) return false;
  const mintedAt = Number(m[1]);
  if (!Number.isFinite(mintedAt)) return false;
  const age = nowMs - mintedAt;
  if (age <= 0) return false; // minted in the future: a clock anomaly, not a stale db
  return age > STALE_TEST_DB_AGE_MS;
}
