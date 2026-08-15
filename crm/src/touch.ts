// Core loop / T5 — the touch lifecycle, and the clock the whole product is about.
//
// 🚨 THE ROW IS INSERTED AT CALL START (I1), not at end of call. Forced by the schema:
// `crm.answers.touch_id` is a foreign key and answers are committed DURING the call, so the
// parent must already exist. `transcript_delivery = 'pending'` is written HERE, before the
// call is even placed — which is what converts a crash between summarising and sending from
// SILENT loss into VISIBLE loss (T13's reconcile lists it). It does not recover the
// transcript. Nothing can.
//
// A consequence worth stating because a guard was once verified against the opposite: THE
// DISPOSITION IS NULL FOR THE WHOLE CALL. Anything asserting a property of "a touch with a
// disposition and answers" must set the answers FIRST and the disposition SECOND, because
// that is the only ordering the system produces.
//
// 🚨 SUCCESS IS NOT "SOMEONE PICKED UP". Success is contact reached AND identity confirmed
// AND questionnaire progressed — which is why `answered` is the only disposition that earns
// the LONG interval, and why `wrong_person` cannot be a flavour of it. The spouse answering
// and taking a message is not an answered questionnaire.
import type pg from "pg";
import { resolveIntervalDays, addDays } from "./due.js";
import { closeFollowUpForProposal } from "./followups.js";

export const DISPOSITIONS = [
  "answered",
  "partial",
  "wrong_person",
  "voicemail",
  "unknown_answer",
  "no_answer",
  "busy",
  "declined",
  "failed",
  // 🚨 EMAIL ONLY, AND IT MEANS SUBMISSION ACCEPTED BY THE RELAY — NOT DELIVERED. The nine
  // above are call outcomes; `resolveDisposition` cannot produce this one. Delivery is
  // knowable only from the bounce feed — polled by `bounces.ts` — so no repo document may
  // describe `'sent'` as delivery.
  "sent",
  // 🚨 EMAIL ONLY: THE RELAY ACCEPTED THE SUBMISSION AND LATER REFUSED TO DELIVER IT.
  // Appended by the bounce reconciler (`bounces.ts`) as a NEW touch beside the `'sent'`
  // one — NEVER by amending it, because the `'sent'` row is not false: the submission WAS
  // accepted. APPEND, NEVER AMEND is the rule, written here because the grant physically
  // permits the flip (`update (disposition, ...)`) and discipline is the only thing
  // preventing it. Not in `LONG_INTERVAL_DISPOSITIONS`: a bounced cycle made no contact,
  // so the clock moves to the short retry. `resolveDisposition` cannot produce this one
  // either.
  "bounced",
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** The dispositions that earn the long interval. Everything else is a short retry —
 *  including `partial`, because a call cut off mid-questionnaire has more to ask.
 *
 *  `'sent'` is here because a submitted email IS the cycle's contact: there is nothing to
 *  retry in three days. Its call-side counterpart `'answered'` means the questionnaire
 *  progressed; `'sent'` claims strictly less — the relay accepted the message — and that is
 *  the most this system can honestly know. */
export const LONG_INTERVAL_DISPOSITIONS: ReadonlySet<Disposition> = new Set([
  "answered",
  "sent",
]);

/** `wrong_person` is the only disposition that moves the dial rotation, and it must: the
 *  next cycle re-dialling the same line reaches the same spouse. */
export const ROTATION_ADVANCING_DISPOSITIONS: ReadonlySet<Disposition> = new Set([
  "wrong_person",
]);

export interface StartTouchInput {
  contactId: string;
  channel: "call" | "email";
  proposalId?: string | null;
  phoneNumberId?: string | null;
  questionSetId?: string | null;
}

/** Inserted at call start: `pending` delivery, NULL disposition.
 *
 *  🚨 AN EMAIL TOUCH IS BORN WITH `transcript_delivery` NULL, and the value is DERIVED FROM
 *  THE CHANNEL rather than supplied by the caller. `'pending'` means "a transcript exists
 *  and has not been sent yet", and T13's reconcile lists it as UNRECOVERABLE LOSS. An email
 *  has no transcript, so `'pending'` on an email touch would be a permanent false alarm in
 *  the one report whose entire value is that it fires only on real loss.
 *
 *  DERIVED, NOT AN OPTION (deliberate): an option is a thing a future caller can forget; a
 *  derivation cannot be. There is no third channel to be wrong about — `016:193` permits
 *  exactly `('call','email')`. */
export async function beginTouch(db: pg.Pool, input: StartTouchInput): Promise<string> {
  const transcriptDelivery = input.channel === "email" ? null : "pending";
  const r = await db.query<{ id: string }>(
    `insert into crm.touches
       (contact_id, channel, proposal_id, phone_number_id, question_set_id, transcript_delivery)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [
      input.contactId,
      input.channel,
      input.proposalId ?? null,
      input.phoneNumberId ?? null,
      input.questionSetId ?? null,
      transcriptDelivery,
    ],
  );
  return r.rows[0].id;
}

export interface TouchOutcome {
  disposition: Disposition;
  reachedOrdinal?: number | null;
  messageLeft?: boolean;
  identityUnverified?: boolean;
}

export interface IntervalSettings {
  defaultIntervalDays: number;
  shortRetryDays: number;
}

export interface RecordTouchResult {
  disposition: Disposition;
  /** Whether THIS touch moved the clock. False when a sibling channel already did. */
  advancedClock: boolean;
  intervalDaysUsed: number | null;
  nextDueAt: Date | null;
  rotationAdvanced: boolean;
}

/**
 * End of call. Writes the disposition, then the clock.
 *
 * 🚨 SIBLING CHANNELS RESET THE CLOCK ONCE, ON THE FIRST SUCCESS. `channel = 'both'`
 * produces TWO proposals sharing one `follow_up_id` (§5.3), and if each of them advanced
 * `next_due_at` on its own the contact would jump TWO intervals into the future for one
 * cycle of contact — silently, and in the direction the product exists to prevent. A
 * failure arriving after a success must likewise not drag the clock back to a short retry:
 * once a sibling has succeeded, this function writes no clock at all.
 *
 * The sibling relationship is read through `crm.follow_up_actions` (proposal_id ->
 * follow_up_id -> the other channel's proposal_id). There is deliberately no `follow_up_id`
 * column on `crm.touches`: the link already exists and duplicating it would give two places
 * to disagree.
 */
export async function recordTouch(
  db: pg.Pool,
  touchId: string,
  outcome: TouchOutcome,
  settings: IntervalSettings,
  now: Date = new Date(),
): Promise<RecordTouchResult> {
  // 🚨 ONE TRANSACTION. The disposition, the rotation, THE FOLLOW-UP CLOSE and the clock all
  // land together or not at all. C1 was: nothing ever closed the follow-up, so the first
  // successful cycle silenced the contact for ever. The close belongs beside the clock — and
  // it must be atomic with it, because "clock advanced, row still open" (a crash between two
  // autocommit statements) reproduces C1 silently, resurfacing 30 days later. If the BEFORE
  // UPDATE wrong-person trigger fires, the whole transaction rolls back — correctly: no
  // clock advance and no close on a defect.
  const client = await db.connect();
  try {
    await client.query("begin");

    const t = await client.query<{
      contact_id: string;
      proposal_id: string | null;
      follow_up_interval_days: number | null;
    }>(
      `select t.contact_id, t.proposal_id, c.follow_up_interval_days
         from crm.touches t join crm.contacts c on c.id = t.contact_id
        where t.id = $1`,
      [touchId],
    );
    if (t.rowCount !== 1) throw new Error(`no such touch: ${touchId}`);
    const { contact_id: contactId, proposal_id: proposalId } = t.rows[0];

    // The disposition first — the answers are already committed, and 016's BEFORE UPDATE
    // trigger is what refuses `wrong_person` against a touch that has any.
    await client.query(
      `update crm.touches
          set disposition = $2, reached_ordinal = $3, message_left = $4, identity_unverified = $5
        where id = $1`,
      [
        touchId,
        outcome.disposition,
        outcome.reachedOrdinal ?? null,
        outcome.messageLeft ?? false,
        outcome.identityUnverified ?? false,
      ],
    );

    const siblingSucceeded =
      proposalId === null ? false : await siblingAlreadySucceeded(client, touchId, proposalId);

    const rotationAdvanced = ROTATION_ADVANCING_DISPOSITIONS.has(outcome.disposition);
    if (rotationAdvanced) {
      await client.query(
        `update crm.contacts set dial_rotation_ordinal = dial_rotation_ordinal + 1,
                                 updated_at = now()
          where id = $1`,
        [contactId],
      );
    }

    // 🚨 THE CLOSE — every executed disposition closes the cycle's row. A retry is not a
    // row left open; it is next cycle's NEW row at the short-retry date. Idempotent, so the
    // second `both` sibling's close is a rowcount-0 no-op (the first leg already closed it).
    // A touch with no proposal (a direct/unit touch) closes nothing. Runs on THIS client, so
    // it is inside the same transaction as the clock; calls the shared helper rather than a
    // second inline copy of the close-by-proposal SQL.
    if (proposalId !== null) {
      await closeFollowUpForProposal(client, proposalId, now);
    }

    if (siblingSucceeded) {
      await client.query("commit");
      return {
        disposition: outcome.disposition,
        advancedClock: false,
        intervalDaysUsed: null,
        nextDueAt: null,
        rotationAdvanced,
      };
    }

    const intervalDays = LONG_INTERVAL_DISPOSITIONS.has(outcome.disposition)
      ? resolveIntervalDays({
          contactIntervalDays: t.rows[0].follow_up_interval_days,
          tenantDefaultDays: settings.defaultIntervalDays,
        })
      : settings.shortRetryDays;

    const next = addDays(now, intervalDays);
    await client.query(
      `update crm.contacts set next_due_at = $2, updated_at = now() where id = $1`,
      [contactId, next.toISOString()],
    );
    await client.query("commit");
    return {
      disposition: outcome.disposition,
      advancedClock: true,
      intervalDaysUsed: intervalDays,
      nextDueAt: next,
      rotationAdvanced,
    };
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function siblingAlreadySucceeded(
  db: pg.Pool | pg.PoolClient,
  touchId: string,
  proposalId: string,
): Promise<boolean> {
  const r = await db.query<{ n: string }>(
    `select count(*) as n
       from crm.follow_up_actions mine
       join crm.follow_up_actions sib on sib.follow_up_id = mine.follow_up_id
       join crm.touches st on st.proposal_id = sib.proposal_id
      where mine.proposal_id = $1
        and st.id <> $2
        and st.disposition = 'answered'`,
    [proposalId, touchId],
  );
  return Number(r.rows[0].n) > 0;
}
