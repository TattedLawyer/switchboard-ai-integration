// Core loop / T13 — reconcile.
//
// 🚨 IT LISTS EXACTLY FOUR THINGS, and the list is closed on purpose:
//
//   1. CLAIMED, NO PROPOSAL — the disclosed non-atomicity between the claim and the door
//      POST. Self-heals when the 15-minute lease expires; listed so a persistent pattern is
//      visible rather than merely survivable.
//   2. BLOCKED FOLLOW-UPS — the anti-silence record. A preference we cannot honour, shown.
//   3. TOUCHES STUCK AT `transcript_delivery = 'pending'` — a crash between storing the
//      summary and sending the transcript. THIS DOES NOT RECOVER THE TRANSCRIPT. NOTHING
//      CAN. It converts silent loss into visible loss, which is the only improvement
//      available.
//   4. `executing` PROPOSALS WITH NO TERMINAL EXECUTION ROW — a crash mid-call. 015 gives
//      `executing` no timer-driven exit and ships no reaper, deliberately: a timer that
//      flips a live in-flight call to `failed` is worse than a stuck row. So it is listed,
//      not swept.
//
// 🚨 "SHARED NUMBERS ACROSS CONTACTS" IS DELIBERATELY ABSENT. §5.2 deleted that listing with
// a reasoned argument: it invites an action — merging — that this design has decided never
// to take, and A LISTING WHOSE ONLY AVAILABLE RESPONSE IS "DO NOTHING" IS A TRAP, NOT
// INFORMATION. Rev 4's prose still carried it while its own pin correctly omitted it; the
// prose was wrong.
//
// RUNS AS THE MIGRATION OWNER. Item 4 reads `approval.proposals`, and `switchboard_crm`
// holds nothing in that schema — correctly. This is an operator tool, in
// `approval-user-add`'s idiom.
import type pg from "pg";
import { CLAIM_LEASE_MINUTES } from "./due.js";

export interface ReconcileReport {
  claimedWithNoProposal: Array<{ contactId: string; displayName: string | null; leaseEndsAt: Date }>;
  blockedFollowUps: Array<{ followUpId: string; contactId: string; dueDate: string; reason: string }>;
  transcriptsStuckPending: Array<{ touchId: string; contactId: string; occurredAt: Date }>;
  executingWithNoOutcome: Array<{ proposalId: string; startedAt: Date }>;
}

export interface ReconcileOptions {
  /** How long a `pending` transcript may sit before it is a problem worth naming. */
  pendingGraceMinutes?: number;
  /** How long an `executing` proposal may sit. */
  executingGraceMinutes?: number;
}

export async function reconcile(
  admin: pg.Pool,
  opts: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const pendingGrace = opts.pendingGraceMinutes ?? 30;
  const executingGrace = opts.executingGraceMinutes ?? 30;

  // 1. Leased right now (the claim pushed `next_due_at` forward by the lease) with nothing
  //    recorded for it since the lease began.
  const claimed = await admin.query<{
    contact_id: string;
    display_name: string | null;
    next_due_at: Date;
  }>(
    `select c.id as contact_id, c.display_name, c.next_due_at
       from crm.contacts c
      where c.active
        and c.channel <> 'none'
        and c.next_due_at > now()
        and c.next_due_at <= now() + ($1 || ' minutes')::interval
        and not exists (
              select 1 from crm.follow_ups f
               where f.contact_id = c.id
                 and f.created_at >= now() - ($1 || ' minutes')::interval)
      order by c.next_due_at`,
    [String(CLAIM_LEASE_MINUTES)],
  );

  const blocked = await admin.query<{
    id: string;
    contact_id: string;
    due_date: string;
    blocked_reason: string;
  }>(
    `select id, contact_id, due_date::text as due_date, blocked_reason
       from crm.follow_ups
      where blocked_reason is not null and closed_at is null
      order by due_date`,
  );

  const pending = await admin.query<{ id: string; contact_id: string; occurred_at: Date }>(
    `select id, contact_id, occurred_at from crm.touches
      where transcript_delivery = 'pending'
        and occurred_at < now() - ($1 || ' minutes')::interval
      order by occurred_at`,
    [String(pendingGrace)],
  );

  const executing = await admin.query<{ proposal_id: string; started_at: Date }>(
    `select p.id as proposal_id, e.at as started_at
       from approval.proposals p
       join approval.executions e on e.proposal_id = p.id and e.kind = 'started'
      where p.state = 'executing'
        and e.at < now() - ($1 || ' minutes')::interval
        and not exists (
              select 1 from approval.executions t
               where t.proposal_id = p.id and t.kind in ('succeeded', 'failed'))
      order by e.at`,
    [String(executingGrace)],
  );

  return {
    claimedWithNoProposal: claimed.rows.map((r) => ({
      contactId: r.contact_id,
      displayName: r.display_name,
      leaseEndsAt: r.next_due_at,
    })),
    blockedFollowUps: blocked.rows.map((r) => ({
      followUpId: r.id,
      contactId: r.contact_id,
      dueDate: r.due_date,
      reason: r.blocked_reason,
    })),
    transcriptsStuckPending: pending.rows.map((r) => ({
      touchId: r.id,
      contactId: r.contact_id,
      occurredAt: r.occurred_at,
    })),
    executingWithNoOutcome: executing.rows.map((r) => ({
      proposalId: r.proposal_id,
      startedAt: r.started_at,
    })),
  };
}

export function formatReconcile(r: ReconcileReport): string {
  const lines: string[] = [];
  lines.push(`claimed with no proposal: ${r.claimedWithNoProposal.length}`);
  for (const c of r.claimedWithNoProposal) {
    lines.push(
      `  ${c.contactId}  ${c.displayName ?? "(no name on file)"}  ` +
        `lease ends ${c.leaseEndsAt.toISOString()}`,
    );
  }
  lines.push(`blocked follow-ups: ${r.blockedFollowUps.length}`);
  for (const b of r.blockedFollowUps) {
    lines.push(`  ${b.followUpId}  contact ${b.contactId}  due ${b.dueDate}  ${b.reason}`);
  }
  lines.push(`transcripts stuck pending: ${r.transcriptsStuckPending.length}`);
  for (const t of r.transcriptsStuckPending) {
    lines.push(
      `  ${t.touchId}  contact ${t.contactId}  ${t.occurredAt.toISOString()}  ` +
        `— the transcript for this call was never sent and CANNOT be recovered`,
    );
  }
  lines.push(`executing with no outcome: ${r.executingWithNoOutcome.length}`);
  for (const e of r.executingWithNoOutcome) {
    lines.push(`  ${e.proposalId}  started ${e.startedAt.toISOString()}`);
  }
  return lines.join("\n");
}
