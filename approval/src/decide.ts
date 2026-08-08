// Phase 3 / A2 — recording what a human decided.
//
// THE CLAIM THIS FILE EXISTS TO MAKE TRUE:
//
//   No proposal can transition to `approved` or `rejected` without an atomically-written
//   decision row of the MATCHING KIND naming an approver — so a human disposition with no
//   attributable human is NOT REPRESENTABLE.
//
// 🚨 AND THE LIMIT OF THAT CLAIM, which must travel with it everywhere: it says nothing
// about WHO PRESSED THE BUTTON. The database authenticates nobody, and the agent host can
// reach the approval service's credential — the credential-locality disclosure in
// KNOWN-ISSUES governs that and is not superseded by anything here.
//
// THE ENFORCEMENT IS NOT IN THIS FILE. It is the BEFORE UPDATE trigger in migration 015,
// and that placement is the whole point: a trigger has no bypass path, so the invariant
// holds on code paths nobody has written yet, including bare psql. This module is the
// WORKFLOW — it is allowed to be wrong without the guarantee failing, and the tests prove
// that by attacking the database directly rather than going through here.
//
// WHY ONE TRANSACTION, AND WHY A DEDICATED CLIENT. The trigger's predicate is "a decision
// row of the matching kind exists for this proposal, WRITTEN IN THIS TRANSACTION",
// discriminated by `pg_current_xact_id()`. Two statements on a pool are two transactions
// and two connections; they would never satisfy it. So both statements run on one client
// inside one explicit BEGIN.
//
// 🚨 `SELECT` ON `approval.decisions` IS A HARD RUNTIME PREREQUISITE, and it is invisible.
// The trigger function is invoker-rights (correctly — no SECURITY DEFINER), so its lookup
// runs with the CALLER's privileges. A future least-privilege narrowing of this role to
// `insert` only on `approval.decisions` would break EVERY approval with `permission denied
// for table decisions` — an error naming a table the operator did not write to.
import type pg from "pg";
import { RENDERER_VERSION } from "./render.js";

export type DecisionKind = "approved" | "rejected" | "dismissed";

export interface DecisionRequest {
  proposalId: string;
  kind: DecisionKind;
  /** A row in `approval.users`. NEVER a string name: an approval whose approver is free
   *  text is an unattributed approval wearing one. */
  approverUserId: string;
  /** Required when `kind === 'rejected'`. The database enforces it too — this check is
   *  the friendly one, not the load-bearing one. */
  reason?: string;
  /** Audit metadata only. 🚨 Never read back in the request path. */
  rendererVersion?: string;
}

export interface DecisionResult {
  decisionId: string;
  /** The proposal's state AFTER the decision. For `dismissed` this is still `pending` —
   *  "Not now" is a decision, not a transition. */
  state: string;
}

export class DecisionRefused extends Error {}

/**
 * Record a decision, and move the proposal if the decision moves it.
 *
 * `dismissed` writes a row and leaves the proposal PENDING. That is why `dismissed` is
 * absent from the state machine: MCP's accept/decline/cancel is right in spirit, but
 * `cancel` is a modal-dismissal event and a web page has no modal — we cannot distinguish
 * "considered it and walked away" from "closed the laptop", and recording the second as
 * the first manufactures evidence about a human's state of mind. Passive navigation
 * records nothing at all; only an explicit "Not now" reaches here.
 */
export async function decide(
  pool: pg.Pool,
  req: DecisionRequest,
): Promise<DecisionResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await decideOn(client, req);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The same decision, on a caller-supplied client inside a transaction the CALLER owns.
 *
 * This exists so several decisions can land ATOMICALLY — `suppress.approveCard()` decides
 * one proposal and disposes of its byte-identical repeats, and a crash between those
 * statements would leave repeats `pending` behind a card the human already answered. It
 * does NOT begin, commit or roll back: doing any of those here would silently break the
 * caller's transaction boundary, and the same-transaction trigger predicate makes that
 * boundary load-bearing rather than cosmetic.
 */
export async function decideOn(
  client: pg.PoolClient,
  req: DecisionRequest,
): Promise<DecisionResult> {
  if (req.kind === "rejected" && (req.reason === undefined || req.reason.trim() === "")) {
    throw new DecisionRefused(
      "a rejection requires a reason: a decision nobody can review later is not a record of one",
    );
  }

  {
    const ins = await client.query<{ id: string }>(
      `insert into approval.decisions
         (proposal_id, kind, approver_user_id, reason, renderer_version)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [
        req.proposalId,
        req.kind,
        req.approverUserId,
        req.reason ?? null,
        req.rendererVersion ?? RENDERER_VERSION,
      ],
    );

    if (req.kind === "dismissed") {
      // No transition. The row accumulates — `approval.decisions` is multi-row per
      // proposal BY DESIGN, which is exactly why the trigger's predicate has to match on
      // KIND: without that, a prior `dismissed` row would satisfy the check for `approved`.
      return { decisionId: ins.rows[0].id, state: "pending" };
    }

    // THE CONDITIONAL UPDATE, with its expected state IN THE PREDICATE and its rowcount
    // checked. Zero rows means somebody else moved it — refuse LOUDLY, never retry blindly.
    // Under READ COMMITTED the row lock serialises concurrent writers and the loser
    // re-evaluates against committed state, so there is no interleaving in which both
    // rowcount checks pass. (The trigger independently rejects illegal transitions, so the
    // invariant survives a caller that forgets this predicate — which is the point of
    // putting it in the database rather than here.)
    const upd = await client.query(
      `update approval.proposals
          set state = $2, decided_at = now()
        where id = $1 and state = 'pending'`,
      [req.proposalId, req.kind],
    );
    if (upd.rowCount !== 1) {
      // Throwing is what rolls this back: the caller owns the transaction, so unwinding it
      // is the caller's job and doing it here would tear down a transaction that may hold
      // more than this decision.
      throw new DecisionRefused(
        `proposal ${req.proposalId} was not pending — somebody or something else moved it. ` +
          "Nothing was recorded.",
      );
    }

    return { decisionId: ins.rows[0].id, state: req.kind };
  }
}
