// Core loop / T5+T9 — the follow-up row: one per contact per due-date, and the anti-silence
// record.
//
// 🚨 A BLOCKED FOLLOW-UP DOES NOT RESET THE CLOCK, and that is the whole reason the state
// exists. `email` preferred with no address on file must NOT fall back to calling —
// overriding her stated preference at the moment we have least information is the worst
// available outcome — and it must not silently drop, which is the original failure. So it
// is recorded, surfaced (T13), and the contact stays due.
//
// 🚨 RECOVERY IS AN UPDATE ON THE EXISTING ROW, NEVER A SECOND INSERT. `unique
// (contact_id, due_date)` refuses the insert with `23505 follow_ups_one_per_due` — measured
// — so a proposer that "recovers" by inserting is a proposer that never recovers. This is
// closing logic and there is no version of this design without it.
import type pg from "pg";

// Every reason a follow-up can be BLOCKED — a data-completeness gap that must SURFACE, never
// silence. `no_email_address` and `no_phone_number` are per-contact; `no_question_set` is a
// tenant-global config gap (she has authored no questions yet) that the surface aggregates.
// `sheet_row_missing` is written by the OWNER-run adoption pass (`sheet-adopt.ts`), not the
// proposer: the contact's row vanished from a healthy sheet snapshot, so the follow-up is
// blocked and the clock paused — never deactivated (owner decision).
// `sheet_divergent` is also the adoption pass's: a value-integrity breaker halt pauses the
// contacts whose sheet values no longer match what is stored — a halt that left outreach
// running against possibly-corrupt stored details would not be a safety measure. Closed by
// the next COMPLETED pass over the same refs.
// `crm.follow_ups.blocked_reason` is `text null` with no CHECK, so adding values needs no
// migration — the type is the contract.
// Family 4 — written by the proposer when the door refuses a crashed cycle's retry because
// the ask's bytes changed since the original POST (a sheet edit, a bounce touch moving the
// date inside the rationale). Without this block the refusal repeats invisibly forever: the
// zero-action orphan freezes the due date, so the deterministic key never rolls, and neither
// expiry nor the close pass can see a row with no actions. Blocking SURFACES it (digest +
// reconcile) and — because blocked rows are excluded from `openZeroActionFollowUpDate` and
// the date-aware guard — lets the next Manila day derive a fresh key and heal on its own.
//
// 🚨 THE TEXT IS HERS, NOT OURS. `blocked_reason` is rendered verbatim to the broker in the
// digest and the reconcile listing, so this one reads as a plain-English sentence, states
// what happened honestly, and tells her the one thing she needs to know: nothing is needed
// from her. No wire jargon (no status codes, no "fingerprint").
// (One literal, no concatenation: `"a" + "b"` types as `string`, which would silently widen
// the BlockedReason union to accept anything.)
// (The promise is deliberately soft: the retry happens on its own, but not necessarily
// first thing the next day — the first next-day cycle can re-derive the old date from the
// claim lease and only the one after rolls to a fresh key — and if her edit removed the
// channel's details entirely there is nothing to propose until she restores them. "Will be
// proposed by the next day" overpromised on both counts.)
export const DETAILS_CHANGED_REASON =
  "an earlier follow-up attempt was interrupted, and this contact's details changed before it could be retried; the system will try again on its own using the contact's current details — nothing for you to do";

// Part 2 — written by the proposer for a MANUAL contact (no sheet row) whose channel wants
// email. 🚨 PER THE OWNER'S RULING this must NOT say "no_email_address": after migration
// 022 the proposer reads email addresses only from the linked sheet, so a manually-added
// contact's address may well be ON FILE and merely unreadable here — reporting "no email
// address" would be a false statement rendered verbatim to the broker. Same plain-English
// standard as DETAILS_CHANGED_REASON: states what is true and names her one available
// action. (One literal, no concatenation — see the note above.)
export const MANUAL_CONTACT_EMAIL_REASON =
  "this contact is not on the linked sheet, and email follow-ups take their address from the sheet — add this contact to the sheet to enable email follow-ups";

// Part 2 — written by the proposer when a sheet row's phone cells contain only entries
// that could not be read as dialable numbers. Distinct from `no_phone_number` on purpose:
// the row HAS numbers, so claiming there are none would be false; what she needs to know
// is that the entries as typed are unreadable, and where to fix them.
export const UNREADABLE_SHEET_PHONES_REASON =
  "the phone numbers on this contact's sheet row could not be read as dialable numbers — fix them on the sheet and calling resumes on its own";

// F2 — written by the proposer when a sheet row's email cell holds something that cannot
// be read as an address ("see business card"). The phone twin above already existed; the
// asymmetry was the defect: unvalidated, the cell's text flowed VERBATIM into
// `payload.to`, and the door's envelope schema accepts it (measured 2026-08-18 — 201, the
// unsendable wrong card would reach her queue and die only after approval, at the
// executor's grammar check). Distinct from `no_email_address` on purpose: the row HAS an
// email cell, so claiming there is none would be false; what she needs to know is that
// the entry as typed is unreadable, and where to fix it. Same standard as its siblings:
// renders verbatim to a non-technical broker, plain English, no wire jargon.
// (One literal, no concatenation — see the note above DETAILS_CHANGED_REASON.)
export const UNREADABLE_SHEET_EMAIL_REASON =
  "the email on this contact's sheet row could not be read as an email address — fix it on the sheet and email follow-ups resume on their own";

export type BlockedReason =
  | "no_email_address"
  | "no_phone_number"
  | "no_question_set"
  | "sheet_row_missing"
  | "sheet_divergent"
  | typeof DETAILS_CHANGED_REASON
  | typeof MANUAL_CONTACT_EMAIL_REASON
  | typeof UNREADABLE_SHEET_PHONES_REASON
  | typeof UNREADABLE_SHEET_EMAIL_REASON;

// 🚨 COMPILE-TIME PIN: the union above must never silently widen to `string`. If any of
// the three `typeof` constants is converted to a concatenation (`"a" + "b"` types as
// `string`), every literal in the union is absorbed and `BlockedReason` accepts anything —
// with ZERO compile errors anywhere else. When that happens the conditional below resolves
// to `never` and the assignment fails `tsc --noEmit` with TS2322. The VALUE form is
// deliberate: an unused type-alias instantiation is deferred and never checked (measured
// 2026-08-18 — the alias form stayed green under the widened constant), so only the
// assignment makes the workspace typecheck (which covers `src`) enforce this. The twin pin
// in door-mismatch-block.test.ts guards any full-program check that includes tests.
type _BlockedReasonStaysNarrow = string extends BlockedReason ? never : true;
const _blockedReasonStaysNarrow: _BlockedReasonStaysNarrow = true;
void _blockedReasonStaysNarrow;

export interface FollowUpRow {
  id: string;
  contactId: string;
  dueDate: string;
  blockedReason: string | null;
  closedAt: Date | null;
}

/**
 * Open (or recover, or resume) the follow-up for a contact's due-date, ATOMICALLY.
 *
 * 🚨 ONE STATEMENT, NOT SELECT-THEN-INSERT. The previous form was a TOCTOU: two proposers
 * that both read "no row" then both insert turned a `23505` into an unhandled throw. The
 * upsert form is available under the exact shipped grants — PostgreSQL 16 docs, opened:
 * "when `ON CONFLICT DO UPDATE` is specified, you only need `UPDATE` privilege on the
 * column(s) that are listed to be updated" (`blocked_reason` is in 016's column grant) plus
 * SELECT on the arbiter columns (granted) — and it collapses THREE paths into one:
 *   · a genuinely new cycle → INSERT;
 *   · the blocked-then-unblocked recovery (B-B) → clears `blocked_reason` on the same row;
 *   · the ORPHAN resume (crash between this open and the door POST left an actionless open
 *     row at this same due_date) → returns the existing row so the proposer re-POSTs the
 *     same deterministic key and the door replays.
 *
 * The clock is never touched here — it lives on `contacts.next_due_at`.
 */
export async function openFollowUp(
  db: pg.Pool,
  contactId: string,
  dueDate: string,
): Promise<FollowUpRow> {
  const r = await db.query<{
    id: string;
    due_date: string;
    blocked_reason: string | null;
    closed_at: Date | null;
  }>(
    `insert into crm.follow_ups (contact_id, due_date) values ($1, $2::date)
       on conflict (contact_id, due_date) do update set blocked_reason = null
     returning id, due_date::text as due_date, blocked_reason, closed_at`,
    [contactId, dueDate],
  );
  return {
    id: r.rows[0].id,
    contactId,
    dueDate: r.rows[0].due_date,
    blockedReason: r.rows[0].blocked_reason,
    closedAt: r.rows[0].closed_at,
  };
}

/**
 * Record a follow-up we cannot act on, WITHOUT touching the clock.
 *
 * 🚨 Minor 4: the return value must describe THIS row's real state, never assert a block
 * that a pre-existing row does not carry. The previous form returned any existing
 * `(contact, due_date)` row unchanged while the caller reported `blocked_reason` regardless
 * — a lie the moment an unblocked row already existed. The upsert makes the block the row's
 * actual state and returns it, so the reported reason and the stored reason cannot diverge.
 */
export async function blockFollowUp(
  db: pg.Pool,
  contactId: string,
  dueDate: string,
  reason: BlockedReason,
): Promise<FollowUpRow> {
  const r = await db.query<{
    id: string;
    due_date: string;
    blocked_reason: string | null;
    closed_at: Date | null;
  }>(
    `insert into crm.follow_ups (contact_id, due_date, blocked_reason) values ($1, $2::date, $3)
       on conflict (contact_id, due_date)
         do update set blocked_reason = coalesce(crm.follow_ups.blocked_reason, excluded.blocked_reason)
     returning id, due_date::text as due_date, blocked_reason, closed_at`,
    [contactId, dueDate, reason],
  );
  return {
    id: r.rows[0].id,
    contactId,
    dueDate: r.rows[0].due_date,
    blockedReason: r.rows[0].blocked_reason,
    closedAt: r.rows[0].closed_at,
  };
}

/**
 * Close a follow-up by its `follow_up_id`, IDEMPOTENTLY and preserving the first close time.
 *
 * `where closed_at is null` makes a late sibling's close a rowcount-0 no-op rather than a
 * timestamp rewrite. `switchboard_crm`'s `update (closed_at, blocked_reason)` grant covers
 * it — the grant that shipped "for the recovery path (B-B)" now earns its second caller.
 */
export async function closeFollowUp(
  db: pg.Pool | pg.PoolClient,
  followUpId: string,
  at: Date = new Date(),
): Promise<void> {
  await db.query(
    `update crm.follow_ups set closed_at = $2 where id = $1 and closed_at is null`,
    [followUpId, at.toISOString()],
  );
}

/** Close the follow-up a touch belongs to, resolved through the shipped link
 *  `touches.proposal_id → follow_up_actions.proposal_id → follow_up_id`. No new column.
 *  Idempotent, and a no-op when the touch has no proposal (a direct/unit touch). */
export async function closeFollowUpForProposal(
  db: pg.Pool | pg.PoolClient,
  proposalId: string,
  at: Date = new Date(),
): Promise<void> {
  await db.query(
    `update crm.follow_ups set closed_at = $2
      where closed_at is null
        and id in (select fa.follow_up_id from crm.follow_up_actions fa
                    where fa.proposal_id = $1)`,
    [proposalId, at.toISOString()],
  );
}

/**
 * Family 3 — the CROSS-MIDNIGHT orphan discriminator: the `due_date` of this contact's
 * open, unblocked, ZERO-ACTION follow-up row, or null.
 *
 * 🚨 THE KEY'S DATE MUST BE READ BACK, NOT RE-DERIVED. The door idempotency key is
 * deterministic on `dueDate`, and on a RETRY `claimedDueAt` is the 15-minute LEASE value —
 * which past Manila midnight lands on the NEXT date, rolls the key, and turns the
 * date-aware guard below into a permanent silence (the orphan at day D counts against a
 * derived day D+1 for ever). The frozen date the key needs already exists on disk:
 * `openFollowUp` wrote it before the door POST. Adopting it makes the retry re-derive the
 * byte-identical key, so the door replays instead of minting a twin.
 *
 * The `NOT EXISTS` zero-action filter is the whole safety of the adoption: a row WITH an
 * action is a genuinely in-flight prior cycle — exactly what `hasOpenFollowUpBefore`
 * exists to suppress — and adopting ITS date would re-serve a live (or declined) card.
 * Blocked rows are a separate, surfaced state and are never adopted. `follow_ups_one_open`
 * (016) guarantees ≤1 candidate; `limit 1` is belt-and-braces, not a hidden choice.
 */
export async function openZeroActionFollowUpDate(
  db: pg.Pool,
  contactId: string,
): Promise<string | null> {
  const r = await db.query<{ due_date: string }>(
    `select f.due_date::text as due_date
       from crm.follow_ups f
      where f.contact_id = $1
        and f.closed_at is null
        and f.blocked_reason is null
        and not exists (select 1 from crm.follow_up_actions fa
                         where fa.follow_up_id = f.id)
      limit 1`,
    [contactId],
  );
  return r.rowCount === 1 ? r.rows[0].due_date : null;
}

/**
 * Is this contact mid-cycle on an EARLIER due date? Blocked rows deliberately do NOT count
 * (B4).
 *
 * 🚨 THE `due_date < $2` CLAUSE IS THE C1 FIX. The previous guard was per-contact and
 * date-independent (`closed_at is null and blocked_reason is null`), so the FIRST open row
 * silenced the contact for ever — the plan's own T9 open-guard pin ("not proposed again
 * even with `next_due_at` moved backwards") was satisfiable by a lifetime lock, which is the
 * failure the product exists to fix, caused by us.
 *
 * An open row from an earlier due date is a genuinely in-flight prior cycle (a card pending
 * approval or execution) — skip, no second card. An open row at THIS SAME due date is either
 * the once-per-due-date suppression the deterministic key already handles, or an orphan to
 * resume — fall through and let `openFollowUp`'s upsert + the door's idempotent replay
 * absorb it (Q3 of the lifecycle research).
 */
export async function hasOpenFollowUpBefore(
  db: pg.Pool,
  contactId: string,
  dueDate: string,
): Promise<boolean> {
  const r = await db.query<{ n: string }>(
    `select count(*) as n from crm.follow_ups
      where contact_id = $1 and closed_at is null and blocked_reason is null
        and due_date < $2::date`,
    [contactId, dueDate],
  );
  return Number(r.rows[0].n) > 0;
}
