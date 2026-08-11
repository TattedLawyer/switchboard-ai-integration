// Core loop / T13 — reconcile, AND the owner-run terminal-state close pass.
//
// 🚨 THE REPORT LISTS FIVE THINGS. The fifth ("passed on") arrived with the close pass — see
// below. The list is still closed on purpose:
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
//   5. PASSED-ON LEADS — a contact whose card she REJECTED. The row is closed (by the close
//      pass) and the contact is stopped, not silently bricked; this listing is how she sees
//      the leads she dismissed and can revisit them. Unlike the shared-numbers trap, its
//      available response is an ACTION (revisit), so it is information, not a trap.
//
// 🚨 "SHARED NUMBERS ACROSS CONTACTS" IS DELIBERATELY ABSENT. §5.2 deleted that listing with
// a reasoned argument: it invites an action — merging — that this design has decided never
// to take, and A LISTING WHOSE ONLY AVAILABLE RESPONSE IS "DO NOTHING" IS A TRAP, NOT
// INFORMATION. Rev 4's prose still carried it while its own pin correctly omitted it; the
// prose was wrong.
//
// 🚨 THE CLOSE PASS WRITES; THE LISTINGS READ. reconcile's old header philosophy was "listed,
// not swept," and that rule STILL governs LIVE `executing` wedges (item 4) — a timer must not
// adjudicate an in-flight call. The close pass is different in kind: it acts only on
// proposals that are ALREADY TERMINAL (`rejected`/`expired`/`execution_failed`), so it
// performs a LIFECYCLE COMPLETION, not a repair of live work. That distinction is the whole
// licence for it to write.
//
// RUNS AS THE MIGRATION OWNER, and this is load-bearing rather than incidental. The close
// pass must read `approval.proposals` (proposal state) AND write `crm.follow_ups` /
// `crm.contacts`. `switchboard_crm` holds NOTHING on `approval.*` and `switchboard_approval`
// holds NOTHING on `crm.*` — the isolation A1/A2 rests on — and the door is one-way with no
// approval→CRM callback. The migration owner is the ONLY principal that can see the terminal
// signal and perform the close, which is exactly why this lives beside reconcile and needs no
// new grant. Nothing here is granted to either service role.
import type pg from "pg";
import { CLAIM_LEASE_MINUTES } from "./due.js";
import { closeFollowUp } from "./followups.js";

export interface ReconcileReport {
  claimedWithNoProposal: Array<{ contactId: string; displayName: string | null; leaseEndsAt: Date }>;
  blockedFollowUps: Array<{ followUpId: string; contactId: string; dueDate: string; reason: string }>;
  transcriptsStuckPending: Array<{ touchId: string; contactId: string; occurredAt: Date }>;
  executingWithNoOutcome: Array<{ proposalId: string; startedAt: Date }>;
  /** Leads she rejected: closed and stopped, surfaced so a "stop" is her move and not a
   *  silent drop. She revisits by re-setting the contact due (`crm-contact-add`-adjacent). */
  passedOnLeads: Array<{ contactId: string; displayName: string | null; dueDate: string; reason: string | null }>;
}

export type CloseReason = "rejected" | "expired_or_failed";

export interface ClosedFollowUp {
  followUpId: string;
  contactId: string;
  reason: CloseReason;
}

/**
 * 🚨 THE TERMINAL-STATE CLOSE PASS — the fix for the "half a fix" C1.
 *
 * `recordTouch` closes a follow-up only on an EXECUTED call. Five terminal states never run
 * it — `rejected` (human), `expired` (machine), `execution_failed`, `superseded`, and an
 * `email` leg with no executor (which ages to `expired`) — so the cycle's row stayed open,
 * and the date-aware open-guard (`due_date < today`) then turned that lingering row into a
 * PERMANENT, INVISIBLE lockout the next Manila day. Proven on live DBs.
 *
 * This pass closes any open, unblocked follow-up whose actions are ALL terminal-non-executed
 * with NO executed sibling, then applies the per-state cadence:
 *
 *   · ANY `rejected` action → STOP AND SURFACE (owner decision). Close the row, set
 *     `next_due_at = NULL` so the loop does NOT auto-serve the card she declined, and let it
 *     appear on the passed-on listing. A rejection is a decision to respect (SOURCED: Odoo
 *     `unlink`s a cancelled activity — no successor, no snooze), not a failure to retry.
 *   · all `expired`/`execution_failed` → RE-PROPOSE. Nobody chose this; the card timed out or
 *     the vendor failed. Close the row and advance `next_due_at` to the START OF THE NEXT DAY
 *     in her timezone — a safe floor that both re-proposes and stops the ~15-min lease churn,
 *     without inventing a follow-up interval nobody set.
 *
 * 🚨 `superseded` IS EXCLUDED. An amendment replaces a pending proposal with a live successor;
 * the follow-up is still live under it, so sweeping it would close a cycle that is not over.
 * Amendment is not reachable in range, so excluding it is conservative and correct.
 */
export async function closeTerminatedFollowUps(
  admin: pg.Pool,
  now: Date = new Date(),
): Promise<ClosedFollowUp[]> {
  const rows = await admin.query<{
    follow_up_id: string;
    contact_id: string;
    has_rejected: boolean;
  }>(
    `select f.id as follow_up_id, f.contact_id, bool_or(p.state = 'rejected') as has_rejected
       from crm.follow_ups f
       join crm.follow_up_actions fa on fa.follow_up_id = f.id
       join approval.proposals p on p.id = fa.proposal_id
      where f.closed_at is null and f.blocked_reason is null
      group by f.id, f.contact_id
     having bool_and(p.state in ('rejected', 'expired', 'execution_failed'))
        and not bool_or(p.state = 'executed')`,
  );

  const closed: ClosedFollowUp[] = [];
  for (const r of rows.rows) {
    // Calls the already-shipped `closeFollowUp` — this pass is its first and only caller
    // (it was dead code before, Minor 1). Deliberately NOT a third inline copy of the close
    // SQL. It is idempotent (`where closed_at is null`), so a concurrent executed sibling's
    // close is not overwritten.
    await closeFollowUp(admin, r.follow_up_id, now);
    if (r.has_rejected) {
      // STOP: NULL is the unambiguous "she passed on this; awaiting her revisit" marker —
      // the claim predicate is `next_due_at <= now`, which NULL never satisfies, so the
      // contact is never auto-claimed again. Intake and every other writer produce a real
      // timestamp, so nothing else reaches NULL.
      await admin.query(
        `update crm.contacts set next_due_at = null, updated_at = now() where id = $1`,
        [r.contact_id],
      );
      closed.push({ followUpId: r.follow_up_id, contactId: r.contact_id, reason: "rejected" });
    } else {
      // RE-PROPOSE tomorrow, in her timezone. "Not today" is the safe floor; the exact
      // interval for a timed-out card is not something we learned, so we do not invent one.
      await admin.query(
        `update crm.contacts c
            set next_due_at = ((date_trunc('day', $2::timestamptz at time zone tz.timezone)
                                + interval '1 day') at time zone tz.timezone),
                updated_at = now()
           from (select coalesce(s.timezone, 'Asia/Manila') as timezone
                   from crm.contacts cc
                   left join crm.outreach_settings s on s.tenant_id = cc.tenant_id
                  where cc.id = $1) tz
          where c.id = $1`,
        [r.contact_id, now.toISOString()],
      );
      closed.push({
        followUpId: r.follow_up_id,
        contactId: r.contact_id,
        reason: "expired_or_failed",
      });
    }
  }
  return closed;
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

  // 5. Passed-on leads: a contact she rejected, now closed and stopped (`next_due_at` NULL),
  //    with no open follow-up. This is the "she said no" surface — visible, revisitable, the
  //    opposite of the silent lockout the close pass was built to end.
  const passedOn = await admin.query<{
    contact_id: string;
    display_name: string | null;
    due_date: string;
    reason: string | null;
  }>(
    // The rejection REASON lives on `approval.decisions` (015 requires one for a rejection),
    // not on `approval.proposals` — the owner can read both.
    `select distinct on (c.id)
            c.id as contact_id, c.display_name, f.due_date::text as due_date, d.reason
       from crm.contacts c
       join crm.follow_ups f on f.contact_id = c.id and f.closed_at is not null
       join crm.follow_up_actions fa on fa.follow_up_id = f.id
       join approval.proposals p on p.id = fa.proposal_id and p.state = 'rejected'
       left join approval.decisions d on d.proposal_id = p.id and d.kind = 'rejected'
      where c.active
        and c.next_due_at is null
        and not exists (select 1 from crm.follow_ups f2
                         where f2.contact_id = c.id and f2.closed_at is null)
      order by c.id, f.due_date desc`,
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
    passedOnLeads: passedOn.rows.map((r) => ({
      contactId: r.contact_id,
      displayName: r.display_name,
      dueDate: r.due_date,
      reason: r.reason,
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
  lines.push(`passed-on leads (rejected — revisit or leave): ${r.passedOnLeads.length}`);
  for (const p of r.passedOnLeads) {
    lines.push(
      `  ${p.contactId}  ${p.displayName ?? "(no name on file)"}  rejected ${p.dueDate}` +
        `${p.reason ? `  — "${p.reason}"` : ""}`,
    );
  }
  return lines.join("\n");
}
