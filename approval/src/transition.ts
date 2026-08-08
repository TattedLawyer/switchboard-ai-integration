// Phase 3 / A2 — every state change, expressed the one safe way.
//
// THE DISCIPLINE, and it is not negotiable anywhere in this service:
//
//     update approval.proposals set state = <next>, decided_at = now()
//      where id = $1 and state = <expected>
//
// The EXPECTED STATE IS IN THE PREDICATE and the ROWCOUNT IS CHECKED. Zero rows means
// somebody else moved it — refuse LOUDLY, never retry blindly, never re-read and try
// again. Confirmed empirically under READ COMMITTED: the row lock serialises concurrent
// writers, the loser re-evaluates against committed state and reports `UPDATE 0`, and
// there is NO interleaving in which both rowcount checks pass.
//
// 🚨 THIS MODULE IS NOT THE ENFORCEMENT. The trigger in migration 015 independently rejects
// every illegal transition, so the invariant holds even for a caller that forgets the
// predicate — including bare psql, and including code nobody has written yet. That is the
// entire reason the invariant lives in the database and the workflow lives here. If you
// are tempted to move the transition rules INTO this file for tidiness, you would be
// converting an invariant into a convention.
//
// MACHINE-DRIVEN VS HUMAN-DRIVEN, which is the distinction the whole design turns on:
//   · `pending -> expired` (the sweeper) and `pending -> superseded` (amendment, and
//     render-time duplicate collapse) carry NO decision row, BECAUSE NOBODY DECIDED;
//   · `pending -> approved` and `pending -> rejected` REQUIRE one, of the matching kind,
//     written in the same transaction, naming an approver.
// Blur that line in either direction and one of two things breaks: expiry becomes
// impossible, or `rejected` stops meaning "a human decided against it".
import type pg from "pg";

/** Every transition the state machine permits. Written out rather than computed, so a
 *  reader can check it against the diagram without running anything. Terminal states have
 *  no entry at all: terminal means terminal, and a re-proposal is a NEW ROW. */
export const LEGAL_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  pending: ["approved", "rejected", "expired", "superseded"],
  approved: ["expired", "executing"],
  executing: ["executed", "execution_failed"],
  rejected: [],
  expired: [],
  superseded: [],
  executed: [],
  execution_failed: [],
};

export class TransitionRefused extends Error {}

/**
 * Move one proposal, conditionally.
 *
 * For `approved` and `rejected` use `decide()` instead — those need a decision row in the
 * SAME transaction, and the database will refuse them from here.
 */
// 🚨 `supersedes` CANNOT BE WRITTEN BY A TRANSITION, and that is a deliberate consequence
// of freezing it. The plan's §3.9(3) describes duplicate-collapse as moving the losing rows
// to `superseded` "with `supersedes` pointing at the approved row" — that is not
// implementable, because §3.2(2) freezes the column and the trigger raises P0001 on any
// UPDATE of it. The link is therefore established only where it can be: AT INSERT, on the
// new row, by amendment (§3.10). For duplicate collapse the relationship is recoverable
// without a column write, because the rows are byte-identical by construction — same
// `(action_type, payload_hash, rationale)` — which is the same key the collapse used to
// group them. Reported rather than papered over.
export async function transition(
  db: pg.Pool | pg.PoolClient,
  opts: { id: string; from: string; to: string },
): Promise<void> {
  const res = await db.query(
    `update approval.proposals set state = $3
      where id = $1 and state = $2`,
    [opts.id, opts.from, opts.to],
  );
  if (res.rowCount !== 1) {
    throw new TransitionRefused(
      `proposal ${opts.id} was not in state '${opts.from}' — it moved under us, so ` +
        `'${opts.to}' was NOT applied and nothing was retried.`,
    );
  }
}
