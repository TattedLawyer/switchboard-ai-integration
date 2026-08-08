// Phase 3 / A2 — the queue read model.
//
// One of expiry's THREE enforcement points (the others are the sweeper and the door's cap
// count): a row past its window is NEVER rendered, whether or not the sweeper has caught
// up with it. The duplication is deliberate — a sweeper alone fails open during exactly
// the outage that matters.
//
// ORDER IS `created_at, id`, AND THE TIEBREAK IS NOT DECORATION. `created_at` defaults to
// `now()`, which in PostgreSQL is TRANSACTION START — so two proposals inserted in the
// same tick tie exactly, and without the id tiebreak the `supersedes` graph that
// duplicate-collapse builds would be nondeterministic. A3's audit story reads that graph.
import type pg from "pg";

export interface QueueRow {
  id: string;
  action_type: string;
  payload: Record<string, unknown>;
  rationale: string;
  payload_hash: string;
  created_at: string;
  expires_at: string;
}

/**
 * Every LIVE pending proposal for this tenant, oldest first.
 *
 * Runs with the shipped runtime grants and nothing more.
 */
export async function readPendingQueue(
  db: pg.Pool | pg.PoolClient,
  tenantId: string,
): Promise<QueueRow[]> {
  const res = await db.query<QueueRow>(
    `select id, action_type, payload, rationale, payload_hash, created_at, expires_at
       from approval.proposals
      where tenant_id = $1
        and state = 'pending'
        and expires_at > now()
      order by created_at, id`,
    [tenantId],
  );
  return res.rows;
}
