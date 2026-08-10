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

export type BlockedReason = "no_email_address";

export interface FollowUpRow {
  id: string;
  contactId: string;
  dueDate: string;
  blockedReason: string | null;
  closedAt: Date | null;
}

/**
 * Open (or recover) the follow-up for a contact's due-date.
 *
 * Returns the row either way. If a row already exists for this `(contact, due_date)` —
 * which is what the blocked path leaves behind — its `blocked_reason` is CLEARED rather
 * than a second row attempted.
 */
export async function openFollowUp(
  db: pg.Pool,
  contactId: string,
  dueDate: string,
): Promise<FollowUpRow> {
  const existing = await selectForDue(db, contactId, dueDate);
  if (existing) {
    if (existing.blockedReason !== null) {
      // THE RECOVERY PATH. The grant covers exactly `(closed_at, blocked_reason)`.
      await db.query(
        `update crm.follow_ups set blocked_reason = null where id = $1`,
        [existing.id],
      );
      return { ...existing, blockedReason: null };
    }
    return existing;
  }
  const r = await db.query<{ id: string }>(
    `insert into crm.follow_ups (contact_id, due_date) values ($1, $2) returning id`,
    [contactId, dueDate],
  );
  return { id: r.rows[0].id, contactId, dueDate, blockedReason: null, closedAt: null };
}

/** Record a follow-up we cannot act on, WITHOUT touching the clock. */
export async function blockFollowUp(
  db: pg.Pool,
  contactId: string,
  dueDate: string,
  reason: BlockedReason,
): Promise<FollowUpRow> {
  const existing = await selectForDue(db, contactId, dueDate);
  if (existing) return existing;
  const r = await db.query<{ id: string }>(
    `insert into crm.follow_ups (contact_id, due_date, blocked_reason)
     values ($1, $2, $3) returning id`,
    [contactId, dueDate, reason],
  );
  return { id: r.rows[0].id, contactId, dueDate, blockedReason: reason, closedAt: null };
}

export async function closeFollowUp(db: pg.Pool, followUpId: string): Promise<void> {
  await db.query(`update crm.follow_ups set closed_at = now() where id = $1`, [followUpId]);
}

async function selectForDue(
  db: pg.Pool,
  contactId: string,
  dueDate: string,
): Promise<FollowUpRow | null> {
  const r = await db.query<{
    id: string;
    due_date: string;
    blocked_reason: string | null;
    closed_at: Date | null;
  }>(
    `select id, due_date::text as due_date, blocked_reason, closed_at
       from crm.follow_ups where contact_id = $1 and due_date = $2::date`,
    [contactId, dueDate],
  );
  if (r.rowCount !== 1) return null;
  return {
    id: r.rows[0].id,
    contactId,
    dueDate: r.rows[0].due_date,
    blockedReason: r.rows[0].blocked_reason,
    closedAt: r.rows[0].closed_at,
  };
}

/** Is this contact already mid-cycle? Blocked rows deliberately do NOT count (B4). */
export async function hasOpenFollowUp(db: pg.Pool, contactId: string): Promise<boolean> {
  const r = await db.query<{ n: string }>(
    `select count(*) as n from crm.follow_ups
      where contact_id = $1 and closed_at is null and blocked_reason is null`,
    [contactId],
  );
  return Number(r.rows[0].n) > 0;
}
