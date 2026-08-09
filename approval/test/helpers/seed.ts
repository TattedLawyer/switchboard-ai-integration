// Test fixtures that reach a state the way the SYSTEM reaches it.
//
// 🚨 WHY THIS HELPER EXISTS, and it is a consequence worth understanding rather than
// working around. Until the creation guard landed, every fixture in this suite that needed
// a non-`pending` proposal simply INSERTED one — `insert ... values (..., 'approved')`.
// That is precisely the forgery the guard now refuses, so those fixtures broke, loudly, all
// at once.
//
// That is the guard working, and the fix is not to exempt tests. A fixture that could
// conjure an `approved` row out of nothing was, all along, testing a state the running
// system cannot produce — and it is exactly the shortcut that let the forgery go unnoticed
// through seven reviews, because the tests had normalised writing states directly. Every
// state below is now reached by the same transitions a real deployment uses: a decision row
// for the human-driven ones, a plain conditional UPDATE for the machine-driven ones.
import type pg from "pg";
import { payloadHash } from "../../src/canonical.js";

export const SEED_TENANT = "00000000-0000-0000-0000-000000000000";

/** An approver row. Created as the owner, which is what the shipped operator CLI does. */
export async function ensureApprover(admin: pg.Pool): Promise<string> {
  const email = `seed-${Math.random().toString(36).slice(2)}@example.com`;
  const r = await admin.query(`insert into approval.users (email) values ($1) returning id`, [
    email,
  ]);
  return r.rows[0].id as string;
}

export interface SeedOptions {
  state?: string;
  /** Where `expires_at` ends up. Applied AFTER the state is reached, because a decision on
   *  an already-expired ask is refused — so an "approved but expired" row can only be built
   *  the way reality builds it: decided while live, then time passes. */
  expiresInHours?: number;
  tenant?: string;
  createdAgoMinutes?: number;
  payload?: Record<string, unknown>;
  rationale?: string;
  approverId?: string;
}

/**
 * A proposal in `state`, reached legally from `pending`.
 *
 * Runs as the OWNER because fixtures need to build states the app role alone cannot (the
 * machine-driven transitions are the approval service's, but `executing -> executed` is
 * A5's and A5 does not exist). Where the provenance of the approver is itself the property
 * under test — T7 and T8 — those suites create theirs through the shipped CLI instead.
 */
export async function seedInState(admin: pg.Pool, opts: SeedOptions = {}): Promise<string> {
  const target = opts.state ?? "pending";
  const payload = opts.payload ?? { to: "jane@client.example.com", n: Math.random() };
  const rationale = opts.rationale ?? "seeded";

  const ins = await admin.query(
    `insert into approval.proposals
       (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash,
        expires_at, created_at)
     values ($1, $2, 'send_email', $3::jsonb, $4, $5,
             now() + interval '72 hours',
             now() - make_interval(mins => $6::int))
     returning id`,
    [
      opts.tenant ?? SEED_TENANT,
      `seed-${Math.random().toString(36).slice(2)}`,
      JSON.stringify(payload),
      rationale,
      payloadHash(payload),
      opts.createdAgoMinutes ?? 0,
    ],
  );
  const id = ins.rows[0].id as string;

  if (target !== "pending") await walkTo(admin, id, target, opts.approverId);

  // Only now move the window, if the fixture wants it closed. Doing this first would make
  // every human-driven target unreachable — which is the I-2 fix doing its job.
  if (opts.expiresInHours !== undefined) {
    await admin.query(
      `update approval.proposals set expires_at = now() + make_interval(hours => $2::int)
        where id = $1`,
      [id, opts.expiresInHours],
    );
  }
  return id;
}

/** The legal route from `pending` to `target`, one transition at a time. */
async function walkTo(
  admin: pg.Pool,
  id: string,
  target: string,
  approverId?: string,
): Promise<void> {
  const decide = async (kind: "approved" | "rejected"): Promise<void> => {
    const approver = approverId ?? (await ensureApprover(admin));
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query(
        `insert into approval.decisions (proposal_id, kind, approver_user_id, reason,
                                         renderer_version)
         values ($1, $2, $3, $4, 'seed')`,
        [id, kind, approver, kind === "rejected" ? "seeded rejection" : null],
      );
      await c.query(`update approval.proposals set state = $2 where id = $1`, [id, kind]);
      await c.query("commit");
    } finally {
      c.release();
    }
  };
  const move = async (from: string, to: string): Promise<void> => {
    const r = await admin.query(
      `update approval.proposals set state = $3 where id = $1 and state = $2`,
      [id, from, to],
    );
    if (r.rowCount !== 1) throw new Error(`seed: could not move ${from} -> ${to}`);
  };

  switch (target) {
    case "approved":
      return decide("approved");
    case "rejected":
      return decide("rejected");
    case "expired":
      return move("pending", "expired");
    case "superseded":
      return move("pending", "superseded");
    case "executing":
      await decide("approved");
      return move("approved", "executing");
    case "executed":
      await decide("approved");
      await move("approved", "executing");
      return move("executing", "executed");
    case "execution_failed":
      await decide("approved");
      await move("approved", "executing");
      return move("executing", "execution_failed");
    default:
      throw new Error(`seed: no legal route to '${target}'`);
  }
}
