// Core loop / T6 — "who is due today", and the claim that stops two proposers calling the
// same person twice.
//
// 🚨 THE OBVIOUS FORM WAS MEASURED DOUBLE-CLAIMING. Rev 2 wrote
//
//     update crm.contacts set next_due_at = <next>
//      where id in (select id from crm.contacts where … limit $2)
//     returning id;
//
// and the round-1 reviewer ran it in two concurrent sessions: BOTH CLAIMED BOTH CONTACTS.
// Under READ COMMITTED the re-checked qualification on EvalPlanQual is
// `id IN (<hashed subplan>)`, and the subplan is not re-evaluated against the updated
// tuple. In this product a double-claim means CALLING THE SAME PERSON TWICE.
//
// The corrected statement below serialises the claim with a ROW LOCK — `for update skip
// locked` inside the scan — and returns the PRE-UPDATE due date, which is the input T9's
// deterministic idempotency key needs. (`returning old.next_due_at` is PG18 syntax and
// ERRORS on this repo's PG 16.14, measured; hence the join form.)
//
// 🚨 THE CLAIM IS A 15-MINUTE LEASE, NOT A RESCHEDULE. `recordTouch` owns the real clock and
// is the only thing that ever writes a follow-up interval. An implementer reaching for the
// follow-up interval here would push a BLOCKED contact 30 days into the future for the
// crime of having been claimed. A crashed cycle costs fifteen minutes.
//
// NO ADVISORY LOCK. PG16's `explicit-locking.html` marks `pg_advisory_lock` inside a
// `LIMIT`ed SELECT "danger!" — that warning is about advisory locks and says nothing
// against `FOR UPDATE SKIP LOCKED`, which is a row lock with entirely different semantics.
// Rev 2's reasoning conflated the two; the hygiene pin stays, narrowed to what it argues.
import type pg from "pg";
import { CLAIM_LEASE_MINUTES } from "./due.js";

export interface ClaimedContact {
  id: string;
  /**
   * The due date this cycle claimed — the value BEFORE the lease overwrote it.
   *
   * 🚨 T9's idempotency key is built from THIS, never from the post-update value. Built
   * from the new date the key would mean "next cycle's date", colliding whenever a short
   * retry landed on a date a prior cycle already claimed — and the collision is SILENTLY
   * SWALLOWED by `proposals_idempotency_unique`, i.e. a follow-up that simply never
   * happens, which is the failure this product exists to fix.
   */
  claimedDueAt: Date;
}

/**
 * Claim up to `limit` due contacts for this cycle.
 *
 * The three predicates are the product controls, expressed where they cannot be forgotten:
 *   · `channel <> 'none'` — the per-prospect control is a QUERY PREDICATE, not a UI setting;
 *   · `active` — she has stood a contact down;
 *   · `next_due_at <= now()` — the loop itself.
 */
export async function claimDue(
  db: pg.Pool | pg.PoolClient,
  tenantId: string,
  limit: number,
): Promise<ClaimedContact[]> {
  const r = await db.query<{ id: string; claimed_due_at: Date }>(
    `update crm.contacts c set next_due_at = now() + ($3 || ' minutes')::interval,
                               updated_at = now()
       from (select id, next_due_at as claimed_due_at
               from crm.contacts
              where tenant_id = $1 and active and channel <> 'none' and next_due_at <= now()
              order by next_due_at limit $2
                for update skip locked) s
      where c.id = s.id
     returning c.id, s.claimed_due_at`,
    [tenantId, limit, String(CLAIM_LEASE_MINUTES)],
  );
  return r.rows.map((row) => ({ id: row.id, claimedDueAt: row.claimed_due_at }));
}
