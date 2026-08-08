// Phase 3 / A2 — expiry, and the wedge it exists to heal.
//
// THE PROBLEM, stated as the RUNBOOK stated it before A2: once the pending cap is hit the
// door 429s PERMANENTLY, legitimate proposals included, because nothing could move a
// pending row to a terminal state. One burst from a compromised or merely enthusiastic
// agent host wedged the queue until an engineer ran SQL by hand.
//
// THREE ENFORCEMENT POINTS, because a sweeper alone fails open during exactly the outage
// that matters:
//
//   1. THIS SWEEPER — moves aged rows to `expired`;
//   2. THE QUEUE READ QUERY — never renders a card for a row past its window;
//   3. THE DOOR'S CAP COUNT — excludes expired rows, so a dead burst does not hold budget
//      even when nothing is running. That is the one that heals with no process alive, and
//      it is why the filter is duplicated rather than centralised.
//
// EXPIRY IS MACHINE-DRIVEN AND CARRIES NO DECISION ROW, because nobody decided. The
// trigger's decision-row predicate deliberately covers only `approved` and `rejected` for
// exactly this reason: requiring one here would either make expiry impossible or make it
// fabricate a decision, and `rejected` would stop meaning "a human decided against it".
//
// 🚨 WHAT THIS COSTS ON THE `approved` SIDE, said plainly. An approved row that is not
// executed within its window becomes `expired`, which is terminal — a DESTROYED HUMAN
// DECISION, with no re-proposal path inside A2 (A5 owns re-proposal). Since A2 ships no
// executor, EVERY approved row meets this timer. It is not unsafe today, because nobody
// can approve until A0b ships login. It becomes unsafe THE DAY A0b LANDS WITHOUT A5. The
// retention is still right — OWASP sources expiry to the approval record, and an approval
// that never lapses is a standing authorisation by another name — but the cost is real and
// is carried in KNOWN-ISSUES rather than absorbed silently.
//
// 🚨 `executing` IS DELIBERATELY EXEMPT AND HAS NO TIMER-DRIVABLE EXIT. A row whose
// executor died stays `executing` forever: the sweeper must not move it, because a timer
// that adjudicates a LIVE IN-FLIGHT SEND as failed is worse than a stuck row. A2 makes the
// state detectable by age (`approval.executions.at` on the `started` row) and hands the
// reaper CONTRACT to A5, which is the task that will know the vendor's delivery semantics.
// This is not a cap wedge — `executing` rows sit outside the pending count — but if A5
// never writes that contract, these rows accumulate silently.
import type pg from "pg";

/** The states a row may age out of. `executing` is absent on purpose; see the header. */
const EXPIRABLE_STATES = ["pending", "approved"] as const;

export interface SweepResult {
  expired: number;
}

/**
 * Move every aged `pending` or `approved` row for this tenant to `expired`.
 *
 * Runs with the shipped runtime grants — `UPDATE (state, decided_at)`, column-level — and
 * nothing more. `decided_at` is deliberately NOT written: nobody decided, and stamping a
 * decision time on a machine-driven transition would put a lie in the audit trail.
 */
export async function sweepExpired(
  db: pg.Pool | pg.PoolClient,
  tenantId: string,
): Promise<SweepResult> {
  const res = await db.query(
    `update approval.proposals
        set state = 'expired'
      where tenant_id = $1
        and state = any($2::text[])
        and expires_at <= now()`,
    [tenantId, EXPIRABLE_STATES as unknown as string[]],
  );
  return { expired: res.rowCount ?? 0 };
}

/** How often the service sweeps. Not a tuning knob anyone has data for: the sweep is
 *  cheap, the cap count heals without it, and the read query filters regardless — so the
 *  interval only affects how promptly a row's STATE catches up with its meaning. */
export const SWEEP_INTERVAL_MS = 60_000;

/**
 * Start the background sweep. Returns a stop function.
 *
 * Failures are logged and never thrown: a sweep that dies must not take the HTTP surface
 * with it, and the two enforcement points that do not depend on this process are precisely
 * what makes that safe.
 */
export function startSweeper(
  db: pg.Pool,
  tenantId: string,
  intervalMs: number = SWEEP_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    void sweepExpired(db, tenantId)
      .then((r) => {
        if (r.expired > 0) {
          console.log(
            `[approval] expired ${r.expired} proposal(s) past their window — cap budget released`,
          );
        }
      })
      .catch((err) => {
        console.error("[approval] expiry sweep failed (the cap count still self-heals):", err);
      });
  }, intervalMs);
  // Never hold the process open on the sweep alone.
  timer.unref?.();
  return () => clearInterval(timer);
}
