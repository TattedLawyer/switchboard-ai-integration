// Core loop / T9 — the proposer. This is the product: it decides who is due and puts a
// real card in her queue.
//
// 🚨 IT DOES NOT INSERT INTO `approval.proposals`. It POSTs to the A2 door with the
// proposal bearer token, exactly as any agent does — that is the whole point of
// `proposal.ts`'s "the agent has a credential to a door that writes on its behalf", and it
// is what keeps every word of 016's grant block earned. Two roles cannot share a
// transaction, so it does not try.
//
// CONSEQUENCE, DISCLOSED RATHER THAN DISCOVERED: the `crm.follow_ups` write and the
// proposal creation are NOT ATOMIC. A crash between them leaves a claimed contact with no
// proposal — the first case T13's reconcile lists, self-healing within the 15-minute claim
// lease.
//
// 🚨 THE CLOCK IS NOT TOUCHED HERE. `recordTouch` owns it. The claim writes a lease and
// nothing else.
import type pg from "pg";
import { z } from "zod";
import { claimDue, type ClaimedContact } from "./claim.js";
import {
  blockFollowUp,
  DETAILS_CHANGED_REASON,
  MANUAL_CONTACT_EMAIL_REASON,
  UNREADABLE_SHEET_EMAIL_REASON,
  UNREADABLE_SHEET_PHONES_REASON,
  hasOpenFollowUpBefore,
  openFollowUp,
  openZeroActionFollowUpDate,
  type BlockedReason,
} from "./followups.js";
import { DoorReplyError } from "./door-reply.js";
import { renderOpening } from "./opening.js";
import { selectQuestionSetForProposal } from "./questions.js";
import { loadSheetCycleContext, type SheetCycleContext } from "./sheet-read.js";
import type { SheetTransport } from "./sheet-client.js";
import type { ContactRowFields } from "./sheet-columns.js";

export type Channel = "call" | "email";

export interface DoorProposal {
  idempotency_key: string;
  action_type: "place_call" | "send_email";
  payload: Record<string, unknown>;
  rationale: string;
}

/** The A2 door, as the proposer sees it. A retry of the same key returns the SAME id —
 *  that is the door's published behaviour and this seam must not paper over it. */
export type PostProposal = (p: DoorProposal) => Promise<{ id: string }>;

export interface ProposerDeps {
  /** `switchboard_crm`. Never the owner. */
  db: pg.Pool;
  postProposal: PostProposal;
  now?: () => Date;
  /** The linked sheet's transport (Part 2). Null/absent means "not configured": with a
   *  linked sheet present, every sheet-bound contact SKIPS each cycle — loudly at the
   *  caller — and manual contacts run unchanged. Never a stored-detail fall-back. */
  sheet?: SheetTransport | null;
}

export interface ProposedAction {
  channel: Channel;
  proposalId: string;
  followUpId: string;
  idempotencyKey: string;
  phoneE164?: string;
  identityUnverified?: boolean;
}

export interface ContactOutcome {
  contactId: string;
  dueDate: string;
  actions: ProposedAction[];
  blockedReason: BlockedReason | null;
  /** Channels owed but not proposed this cycle, with why. See the `both` note below. */
  skipped: Array<{ channel: Channel; reason: string }>;
}

// 🚨 NO DETAIL COLUMNS. Post-022 `switchboard_crm` cannot SELECT `email_address`,
// `source_detail` or `looking_for` — details come from the LIVE sheet row (sheet-bound
// contacts) or are honestly null (manual contacts). Widening this row shape back is a
// 42501 at runtime, pinned in migration-022.test.ts.
interface ContactRow {
  id: string;
  tenant_id: string;
  display_name: string | null;
  channel: "call" | "email" | "both" | "none";
  follow_up_interval_days: number | null;
  linked_sheet_id: string | null;
  row_ref: string | null;
}

interface SettingsRow {
  timezone: string;
  opening_line: string;
  opening_line_no_name: string;
  default_interval_days: number;
}

interface NumberRow {
  id: string;
  phone_e164: string;
  ordinal: number;
}

/** The due-date in HER timezone. The date is half the idempotency key, so computing it in
 *  the server's locale would make the key move when the server moved. */
export function dueDateIn(at: Date, timezone: string): string {
  // en-CA renders ISO-like YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export function idempotencyKey(contactId: string, dueDate: string, channel: Channel): string {
  // 🚨 DETERMINISTIC, and built from the date T6's claim RETURNED (the pre-update value).
  // Anything time-varying here — `Date.now()`, a uuid — turns one ask into a new card every
  // cycle, which is the flood the door's unique key exists to stop.
  return `followup:${contactId}:${dueDate}:${channel}`;
}

export async function runCycle(
  deps: ProposerDeps,
  tenantId: string,
  limit: number,
): Promise<ContactOutcome[]> {
  const claimed = await claimDue(deps.db, tenantId, limit, deps.now?.() ?? new Date());
  if (claimed.length === 0) return [];
  // 🚨 ONE SNAPSHOT PER CYCLE, never per contact: every claimed contact reads the same
  // sheet state, and the API is hit once however large the batch.
  const sheetCtx = await loadSheetCycleContext(deps.db, tenantId, deps.sheet ?? null);
  const out: ContactOutcome[] = [];
  for (const c of claimed) {
    out.push(await proposeForClaimed(deps, tenantId, c, sheetCtx));
  }
  return out;
}

export async function proposeForClaimed(
  deps: ProposerDeps,
  tenantId: string,
  claimed: ClaimedContact,
  // Default = "no linked sheet". Under the default a SHEET-BOUND contact SKIPS (fail-safe
  // — never the stored copy); manual contacts are unaffected. `runCycle` and the daemon
  // always pass the real cycle context.
  sheetCtx: SheetCycleContext = { kind: "no_linked_sheet" },
): Promise<ContactOutcome> {
  const { db } = deps;
  const settings = await loadSettings(db, tenantId);
  const claimedDate = dueDateIn(claimed.claimedDueAt, settings.timezone);
  const contact = await loadContact(db, claimed.id);

  const channels: Channel[] =
    contact.channel === "both"
      ? ["call", "email"]
      : contact.channel === "none"
        ? []
        : [contact.channel];

  // ── The LIVE row for a sheet-bound contact (Part 2 / Piece A). ────────────────────────
  // 🚨 SHEET UNREACHABLE => SKIP, NOT BLOCK. No follow_ups row, no blocked reason, no
  // clock write — the 15-minute claim lease this cycle already took simply expires and
  // the next cycle re-claims. NEVER fall back to stored details: the card would carry
  // exactly the stale data the live read exists to kill (and post-022 this role cannot
  // read them anyway — the 42501 is the control, pinned in migration-022.test.ts).
  //
  // 🚨 A ROW ABSENT FROM THE SNAPSHOT (deleted, or cleared to blanks — the cell-clearing
  // rule) is the SAME skip: recording `sheet_row_missing` is the OWNER-run adoption
  // pass's job. Note the boundary honestly: 016's grants DO let this role insert a
  // follow_ups block and null next_due_at (both were proved reachable), so writing the
  // block here is prevented by CONVENTION, not by a permission — the convention being
  // that a missing-row verdict belongs to the pass that also detects recovery and
  // restarts the clock, and a proposer-side copy of it would fight that lifecycle. This
  // comment pins the boundary; do not claim a 42501 enforces it.
  let live: ContactRowFields | null = null;
  if (contact.row_ref !== null) {
    const skip = (reason: string): ContactOutcome => ({
      contactId: contact.id,
      dueDate: claimedDate,
      actions: [],
      blockedReason: null,
      skipped: channels.map((channel) => ({ channel, reason })),
    });
    // 🚨 F1b — AN OPEN SHEET-LEVEL BLOCK GATES THE LIVE READ TOO. `sheet_divergent` (a
    // value-integrity breaker halt paused this contact: its sheet values no longer match
    // what is stored) and `sheet_row_missing` (its row vanished from a healthy snapshot)
    // are the OWNER-run adoption pass's verdicts, and that pass also owns recovery —
    // closing the block and restarting the clock. A contact can be DUE while such a block
    // is open (an executed in-flight card's recordTouch restarts the clock), and
    // proposing from the live row then would build a card from the very values the pass
    // declared untrustworthy — or resurrect a row she deleted. Worse, `openFollowUp`'s
    // upsert CLEARS `blocked_reason` on today's row (the B-B recovery path), so a propose
    // here would STEAMROLL the pass's block on its way to the wrong card. Skip: no
    // proposal, no new row, no clock change — the pass's next completed run closes the
    // block and outreach resumes. 016 grants this role SELECT on `crm.follow_ups`
    // (confirmed against the migration's grant block).
    const paused = await db.query(
      `select 1 from crm.follow_ups
        where contact_id = $1 and closed_at is null
          and blocked_reason in ('sheet_row_missing', 'sheet_divergent')
        limit 1`,
      [contact.id],
    );
    if ((paused.rowCount ?? 0) > 0) {
      return skip(
        "this contact is paused by a sheet-level block (its sheet row went missing or " +
          "its values diverged from storage); the sheet adoption pass owns recovery — " +
          "nothing was proposed this cycle",
      );
    }
    if (sheetCtx.kind === "unavailable") {
      return skip(
        `the linked sheet could not be read this cycle (${sheetCtx.reason}); ` +
          `nothing was proposed or recorded — the claim lease expires and the next cycle retries`,
      );
    }
    if (sheetCtx.kind === "no_linked_sheet" || sheetCtx.linkedSheetId !== contact.linked_sheet_id) {
      return skip(
        "this contact is bound to a sheet that is not the active linked sheet this cycle; " +
          "nothing was proposed — the claim lease expires and the next cycle retries",
      );
    }
    const row = sheetCtx.rowsByRef.get(contact.row_ref);
    if (row === undefined) {
      return skip(
        "this contact's sheet row was not in the snapshot (deleted or cleared); " +
          "nothing was proposed — the sheet adoption pass records missing rows",
      );
    }
    live = row;
  }

  // 🚨 FAMILY 3 — FREEZE THE KEY ACROSS MIDNIGHT BY READING IT BACK, never re-deriving it.
  // On a RETRY, `claimedDueAt` is the 15-minute LEASE value the previous cycle wrote — which
  // past Manila midnight lands on the NEXT date, rolls the deterministic idempotency key,
  // and turns the date-aware guard below into a PERMANENT silence (the crash orphan at day D
  // counts against a derived day D+1 for ever; same-day the ORPH path self-heals, cross-day
  // it never did). The frozen date already exists on disk: `openFollowUp` committed it to
  // `follow_ups.due_date` before the door POST. So: if the contact has an open, unblocked,
  // ZERO-ACTION row (the orphan discriminator — a has-action row is a live prior cycle the
  // guard must keep suppressing), adopt ITS date; the retry then re-derives the
  // byte-identical key, the guard passes (same date, not earlier), `openFollowUp`'s upsert
  // resumes the same row, and the door REPLAYS instead of minting a twin. Same-day this is a
  // no-op (adopted date == claimedDate). Read-back only: no migration, no new grant.
  const adopted = await openZeroActionFollowUpDate(db, contact.id);
  const dueDate = adopted ?? claimedDate;

  // The open-guard, now date-aware (C1). A contact mid-cycle on an EARLIER due date — a card
  // still pending approval or execution — is not proposed again. An open row at THIS same
  // due date falls through: the deterministic key + the door's idempotent replay make a
  // re-proposal safe, and that is what lets an orphaned open row (crash between the open and
  // the door POST) self-heal on the next cycle. Blocked rows do not count (B4).
  if (await hasOpenFollowUpBefore(db, contact.id, dueDate)) {
    return {
      contactId: contact.id,
      dueDate,
      actions: [],
      blockedReason: null,
      skipped: [{ channel: "call", reason: "an open follow-up from an earlier due date exists" }],
    };
  }

  // 🚨 OPTION B (V3): COMPUTE THE BUILDABLE LEGS FIRST, open the row only if ≥1 leg builds.
  //
  // The follow-up row must never exist without work to do. Opening it unconditionally (the
  // old shape) left an OPEN, UNBLOCKED, ACTION-LESS row whenever every leg resolved to
  // nothing — a `call`/`both` contact with no number, or with no active question set — which
  // the close pass (an INNER JOIN through `follow_up_actions`) can never see, and which the
  // date-aware guard then silences the next Manila day. That was the third recurrence of the
  // permanent-silence class. Odoo's `check_res_id_is_set` forbids the same empty-activity
  // state: the work row exists BECAUSE there is executable work.
  //
  // So: build every wanted leg without posting; if ZERO build, `blockFollowUp` (surfaced,
  // guard-excluded, recoverable via the shipped upsert) and return WITHOUT opening a row; if
  // ≥1 builds, open the row and post only the buildable legs. A partial gap (`both` with one
  // buildable leg — P4a) is NOT a silence: it opens normally and the missing arm is a
  // data-completeness item, not a block.
  const legs = channels.map((channel) => ({
    channel,
    build:
      channel === "call"
        ? buildCallProposal(db, tenantId, contact, live, settings, idempotencyKey(contact.id, dueDate, channel))
        : Promise.resolve(buildEmailProposal(contact, live, idempotencyKey(contact.id, dueDate, channel))),
  }));
  const resolved = await Promise.all(
    legs.map(async (l) => ({ channel: l.channel, result: await l.build })),
  );
  const buildable = resolved.filter((l) => l.result.ok);

  if (buildable.length === 0) {
    // Every wanted leg failed or skipped. Pick the PRIMARY block reason — a call-arm data
    // gap (`no_phone_number` / unreadable phones / `no_question_set`) outranks the
    // email-arm one, so a `both` with no address surfaces the more actionable gap.
    // `channel = 'none'` yields no legs and is not a data gap she can fix, so it blocks
    // nothing and simply returns. A leg that SKIPPED (sheet numbers awaiting adoption)
    // never contributes a block reason: a skip is "not this cycle", a block is a
    // surfaced data gap, and conflating them would write a false reason to her queue.
    const reasons = resolved.flatMap((l) =>
      !l.result.ok && l.result.kind === "block" ? [l.result.blockReason] : [],
    );
    const primary =
      reasons.find((r) => r === "no_phone_number") ??
      reasons.find((r) => r === UNREADABLE_SHEET_PHONES_REASON) ??
      reasons.find((r) => r === "no_question_set") ??
      reasons.find((r) => r === UNREADABLE_SHEET_EMAIL_REASON) ??
      reasons.find((r) => r === "no_email_address") ??
      reasons.find((r) => r === MANUAL_CONTACT_EMAIL_REASON) ??
      null;
    if (primary === null) {
      // Nothing blockable: `none`, or every leg skipped this cycle. No row is opened
      // (Option B) and no block is written — the skip reasons surface in the return.
      return {
        contactId: contact.id,
        dueDate,
        actions: [],
        blockedReason: null,
        skipped: resolved
          .filter((l) => !l.result.ok)
          .map((l) => ({ channel: l.channel, reason: legReason(l.result as LegFail | LegSkip) })),
      };
    }
    await blockFollowUp(db, contact.id, dueDate, primary);
    return {
      contactId: contact.id,
      dueDate,
      actions: [],
      blockedReason: primary,
      skipped: resolved
        .filter((l) => !l.result.ok)
        .map((l) => ({ channel: l.channel, reason: legReason(l.result as LegFail | LegSkip) })),
    };
  }

  // ≥1 buildable leg — NOW open the row (never before), and post the buildable legs.
  const followUp = await openFollowUp(db, contact.id, dueDate);
  const actions: ProposedAction[] = [];
  const skipped: ContactOutcome["skipped"] = [];

  for (const leg of resolved) {
    if (!leg.result.ok) {
      // A partial gap on a contact that DID produce ≥1 action (P4a): a data-completeness
      // item, not a silence. Surfaced in the return value; the row is open and healthy.
      skipped.push({ channel: leg.channel, reason: legReason(leg.result) });
      continue;
    }
    const built = leg.result;
    const key = idempotencyKey(contact.id, dueDate, leg.channel);

    // 🚨 FAMILY 4 — THE CHANGED-RETRY POISON, and the ONE status this catch may match.
    //
    // A crash between the POST below and the action insert leaves a zero-action orphan that
    // retries under the SAME frozen key (Family 3). If ANY fingerprint byte changed in the
    // meantime — a sheet edit to the email, a bounce touch moving the date inside
    // `lastTouchSummary`'s rationale — the door refuses 422 for ever: the orphan freezes the
    // due date so the key never rolls, expiry cannot heal it (the close pass inner-joins
    // through actions and cannot see a zero-action row; the fingerprint pre-check answers
    // before the terminal-replay branch, so even an `expired` row poisons the key), and
    // nothing surfaces — permanent, invisible silence. So a 422 becomes a SURFACED BLOCK:
    // blocked rows are excluded from `openZeroActionFollowUpDate` and from the date-aware
    // guard, so the next Manila day derives a fresh key and the contact heals on its own.
    //
    // 🚨 422 ONLY. NEVER 409. A 409 terminal replay happens NORMALLY in the same-day window
    // between an `execution_failed` outcome and the close pass running — and the close pass
    // (`closeTerminatedFollowUps`) requires `blocked_reason is null`, so blocking on 409
    // would strand that row open-blocked for ever. A 409 must keep propagating (or, once an
    // adapter interprets it through `interpretDoorReply`, resolve to the id): it is an
    // answer, not a mismatch. Every other status (429, 5xx, transport) is transient and
    // must keep throwing so the lease retries it.
    let posted: { id: string };
    try {
      posted = await deps.postProposal(built.proposal);
    } catch (err) {
      if (err instanceof DoorReplyError && err.status === 422) {
        // 🚨 ONLY WHEN NO LEG HAS POSTED THIS CYCLE. A sibling that already posted means
        // this row carries a LIVE CARD pending in her queue. Blocking the row would (a)
        // hide it from the date-aware guard, so the next day proposes BOTH legs again and
        // she gets a second pending call card for the same contact, and (b) hide it from
        // the close pass (`closeTerminatedFollowUps` requires `blocked_reason is null`),
        // so a rejection of that live card would strand the row open for ever. The refused
        // leg is reported skipped with an honest reason; the open ACTIONED row then
        // suppresses tomorrow via `hasOpenFollowUpBefore` and closes normally when the
        // live card reaches a terminal state. Pinned in door-mismatch-block T5/T6.
        if (actions.length > 0) {
          skipped.push({
            channel: leg.channel,
            reason:
              "an earlier attempt on this channel was interrupted, and the contact's details " +
              "changed before it could be retried; skipped this cycle — the follow-up " +
              "continues on the channel whose card is already in the queue",
          });
          continue;
        }
        const row = await blockFollowUp(db, contact.id, dueDate, DETAILS_CHANGED_REASON);
        skipped.push({ channel: leg.channel, reason: DETAILS_CHANGED_REASON });
        // Legs not yet posted are NOT posted against a row just declared dead — a sibling
        // card here would double-serve tomorrow, when the fresh key re-proposes them all.
        for (const rest of resolved.slice(resolved.indexOf(leg) + 1)) {
          if (rest.result.ok) {
            skipped.push({
              channel: rest.channel,
              reason: "not proposed — this follow-up was blocked this cycle",
            });
          }
        }
        return {
          contactId: contact.id,
          dueDate,
          actions,
          // Minor-4 discipline: report the row's REAL stored state, which `blockFollowUp`'s
          // coalesce preserves if some other writer blocked it first.
          blockedReason: (row.blockedReason ?? DETAILS_CHANGED_REASON) as BlockedReason,
          skipped,
        };
      }
      throw err;
    }
    const { id } = posted;
    await db.query(
      `insert into crm.follow_up_actions (follow_up_id, channel, proposal_id)
       values ($1, $2, $3)
       on conflict (follow_up_id, channel) do nothing`,
      [followUp.id, leg.channel, id],
    );
    actions.push({
      channel: leg.channel,
      proposalId: id,
      followUpId: followUp.id,
      idempotencyKey: key,
      phoneE164: built.phoneE164,
      identityUnverified: built.identityUnverified,
    });
  }

  return { contactId: contact.id, dueDate, actions, blockedReason: null, skipped };
}

interface BuiltProposal {
  ok: true;
  proposal: DoorProposal;
  phoneE164?: string;
  identityUnverified?: boolean;
}
interface LegFail {
  ok: false;
  kind: "block";
  blockReason: BlockedReason;
}
/** "Not this cycle", as distinct from a surfaced data gap: nothing is opened and nothing
 *  is blocked — the reason travels in the outcome's `skipped` (and the daemon log) and
 *  the claim lease retries. Used when the sheet's numbers have not been adopted yet: a
 *  `no_phone_number` block there would be a false statement about her sheet. */
interface LegSkip {
  ok: false;
  kind: "skip";
  reason: string;
}
type LegBuild = BuiltProposal | LegFail | LegSkip;

const legReason = (r: LegFail | LegSkip): string =>
  r.kind === "block" ? r.blockReason : r.reason;

async function buildCallProposal(
  db: pg.Pool,
  tenantId: string,
  contact: ContactRow,
  live: ContactRowFields | null,
  settings: SettingsRow,
  key: string,
): Promise<LegBuild> {
  // 🚨 CONTACT-SCOPED, and the scope is load-bearing: this is the ONLY source of the
  // E.164 → phone_number_id resolution below. `loadNumbers` selects
  // `where contact_id = $1`, so a number that appears on this contact's sheet row but is
  // STORED under a different contact (a displaced value — a sort, a cross-row paste, a
  // shared household line mid-reorganisation) can never resolve to that other contact's
  // phone_number_id. Unscoped, it would corrupt both the call payload and the touch
  // attribution that hangs off phone_number_id. Pinned (P6, proposer-sheet.test.ts).
  const numbers = await loadNumbers(db, contact.id);

  interface Candidate {
    id: string;
    phone_e164: string;
  }
  let candidates: Candidate[];
  let listLabel: (idx: number) => string;

  if (live === null) {
    // MANUAL CONTACT — the call leg is unchanged: stored numbers, stored dial order.
    if (numbers.length === 0) return { ok: false, kind: "block", blockReason: "no_phone_number" };
    candidates = numbers;
    // The stored ordinal, as before, so the card names the entry she recognises.
    listLabel = (idx) => `entry ${numbers[idx].ordinal + 1} of ${numbers.length}`;
  } else {
    // SHEET-BOUND CONTACT — 🚨 THE PHONE FIX. Dial candidates are the LIVE sheet numbers
    // in SHEET ORDER, deduped by E.164 (two columns, or two spellings of one number,
    // would otherwise inflate the list and skew the rotation), each resolved to its
    // stored row purely to supply the phone_number_id the payload grammar requires. A
    // stored number absent from the sheet is filtered BY ABSENCE — never deleted (016
    // grants no DELETE; removal stays an operator action).
    const byE164 = new Map(numbers.map((n) => [n.phone_e164, n]));
    const seen = new Set<string>();
    const liveOrder = live.phones.filter((p) => {
      if (seen.has(p.e164)) return false;
      seen.add(p.e164);
      return true;
    });
    candidates = liveOrder.flatMap((p) => {
      const stored = byE164.get(p.e164);
      return stored === undefined ? [] : [{ id: stored.id, phone_e164: stored.phone_e164 }];
    });
    if (candidates.length === 0) {
      if (liveOrder.length > 0) {
        // The row DOES carry phones; storage just hasn't adopted them yet. A
        // `no_phone_number` block would be FALSE — skip this cycle and let the owner-run
        // adoption pass sync them (its insert-only phone sync exists for exactly this).
        return {
          ok: false,
          kind: "skip",
          reason:
            "the sheet lists phone number(s) not yet adopted into storage; skipped this " +
            "cycle — the sheet adoption pass syncs them",
        };
      }
      if (live.phoneProblems.length > 0) {
        // Numbers exist but none could be read. Say THAT, not "there are none".
        return { ok: false, kind: "block", blockReason: UNREADABLE_SHEET_PHONES_REASON };
      }
      return { ok: false, kind: "block", blockReason: "no_phone_number" };
    }
    listLabel = (idx) => `entry ${idx + 1} of ${candidates.length}`;
  }

  const set = await selectQuestionSetForProposal(db, tenantId);
  if (set === null) return { ok: false, kind: "block", blockReason: "no_question_set" };

  // 🚨 MODULO THE LIVE COUNT, never the stored ordinal used as an array index. She deletes
  // a number (manual) or removes one from the sheet (sheet-bound) and the stored rotation
  // index is suddenly past the end — an index straight into the array either crashes or
  // skips the whole list.
  const rotation = await currentRotation(db, contact.id);
  const idx = rotation % candidates.length;
  const pick = candidates[idx];

  // The name the card renders and the agent speaks: LIVE for a sheet-bound contact —
  // a correction on the sheet reaches the very next card, no adoption pass in between.
  const displayName = live === null ? contact.display_name : live.displayName;
  const opening = renderOpening(displayName, {
    openingLine: settings.opening_line,
    openingLineNoName: settings.opening_line_no_name,
  });

  const last = await lastTouchSummary(db, contact.id, settings.timezone);
  const intervalDays = contact.follow_up_interval_days ?? settings.default_interval_days;

  return {
    ok: true,
    phoneE164: pick.phone_e164,
    identityUnverified: opening.identityUnverified,
    proposal: {
      idempotency_key: key,
      action_type: "place_call",
      payload: {
        contact_id: contact.id,
        phone_number_id: pick.id,
        phone_e164: pick.phone_e164,
        display_name: displayName,
        opening_line: opening.line,
        question_set_id: set.id,
        context: {
          // LIVE for sheet-bound; honestly null for manual — post-022 the stored copies
          // are unreadable to this role, and a null beats a stale or invented value.
          source_detail: live === null ? null : live.sourceDetail,
          looking_for: live === null ? null : live.lookingFor,
        },
      },
      // 🚨 WHY THIS CONTACT, WHY NOW, WHICH NUMBER. A constant rationale is "an instruction
      // wearing a proposal's clothes" (proposal.ts:38-39) — the human cannot judge an ask
      // that does not say what it is. The entry count is the count of numbers ACTUALLY
      // dialable today — for a sheet-bound contact that is the live candidate list, so a
      // stale stored number can never be presented as a legitimate "entry 1 of 2".
      rationale:
        `${displayName ?? "This number has no name on file"} is due: ` +
        `${last} · follow-up interval ${intervalDays} days · ` +
        `calling ${pick.phone_e164} (${listLabel(idx)}).` +
        (opening.path === "nameless"
          ? " No name on file, so the agent opens as an associate of yours and the answers " +
            "will be stored labelled identity-unverified."
          : ""),
    },
  };
}

/** The `to` rules of the door's `followUpEmailPayloadSchema`, copied byte-for-byte from
 *  `approval/src/proposal.ts` — `crm/src` may not import `approval/src` (executor.ts's
 *  ban), so the copy is deliberate and names its source, exactly as scheduler.ts copies
 *  expiry's shape. The door and the executor stay authoritative downstream; this is the
 *  proposer refusing to BUILD what they would refuse to send. */
const liveEmailShape = z
  .string()
  .min(3)
  .max(254)
  .email()
  .refine((v) => !v.includes(","), { message: "one recipient only" })
  .refine((v) => v === v.trim(), { message: "leading/trailing whitespace" });

function buildEmailProposal(
  contact: ContactRow,
  live: ContactRowFields | null,
  key: string,
): LegBuild {
  // 🚨 MANUAL CONTACT: post-022 the proposer cannot read a stored address at all, and PER
  // THE OWNER'S RULING it must not claim "no_email_address" — the address may be on file
  // and merely unreadable. The HONEST reason says the contact is not on the linked sheet.
  // Intake (`crm-contact-add`, owner role) keeps accepting such contacts unchanged.
  if (live === null) {
    return { ok: false, kind: "block", blockReason: MANUAL_CONTACT_EMAIL_REASON };
  }
  // 🚨 EMAIL PREFERRED, NO ADDRESS ON THE SHEET is a BLOCK, not a fall-back to calling —
  // overriding her stated preference at the moment we have least information is the worst
  // available outcome. The email leg simply fails to build; whether that becomes a blocked
  // row depends (Option B) on whether any OTHER leg built. (`contactRowFields` already
  // normalizes an empty cell to null.)
  if (live.emailAddress === null) {
    return { ok: false, kind: "block", blockReason: "no_email_address" };
  }
  // 🚨 F2 — THE DOOR'S OWN SHAPE RULES, APPLIED BEFORE THE LEG BUILDS. A cell like
  // "see business card" is an email COLUMN entry, not an address; unvalidated it flowed
  // VERBATIM into `payload.to`, and the door's envelope schema accepts the payload
  // opaquely (measured 2026-08-18: HTTP 201), so the unsendable wrong card would reach
  // her queue and die only after approval, at the executor's grammar check. The phone leg
  // already had its twin (UNREADABLE_SHEET_PHONES_REASON); the asymmetry was the defect.
  // A refusal here becomes a SURFACED block with the honest reason — never the false
  // "no_email_address" (the row HAS an email cell), never a card she cannot judge.
  // Nothing is transformed: `checkSendable`'s rule — refuse, don't normalise.
  if (!liveEmailShape.safeParse(live.emailAddress).success) {
    return { ok: false, kind: "block", blockReason: UNREADABLE_SHEET_EMAIL_REASON };
  }
  const who = live.displayName ?? "there";
  return {
    ok: true,
    proposal: {
      idempotency_key: key,
      action_type: "send_email",
      payload: {
        contact_id: contact.id,
        // THE `to` IS THE SHEET'S, read this cycle: an address she corrected reaches the
        // very next card with no adoption pass in between (P2).
        to: live.emailAddress,
        subject: "Following up",
        body:
          `Hi ${who} — just following up on our conversation` +
          (live.lookingFor ? ` about ${live.lookingFor}` : "") +
          `. Is now a good time to talk?`,
      },
      rationale:
        `${who} is due and prefers email` +
        (live.sourceDetail ? ` (met at ${live.sourceDetail})` : "") +
        `. Single message, no sequence.`,
    },
  };
}

async function lastTouchSummary(
  db: pg.Pool,
  contactId: string,
  timezone: string,
): Promise<string> {
  const r = await db.query<{ occurred_at: Date; disposition: string | null }>(
    `select occurred_at, disposition from crm.touches
      where contact_id = $1 order by occurred_at desc limit 1`,
    [contactId],
  );
  if (r.rowCount !== 1) return "never contacted";
  const d = r.rows[0];
  // 🚨 RENDERED IN HER TIMEZONE, never UTC. A touch whose instant fell 00:00–08:00 Manila
  // (16:00–24:00 UTC — every bounce the reconciler appends overnight, every off-window
  // execution) rendered the PREVIOUS Manila day under `toISOString()`, permanently, on the
  // one field a human reads to decide. NOTE the rationale is part of the door's idempotency
  // FINGERPRINT and the suppression key — changing these bytes has a bounded deploy ripple
  // (see the 2026-08-16 fix commit).
  return `last contacted ${dueDateIn(d.occurred_at, timezone)} (${d.disposition ?? "in progress"})`;
}

async function currentRotation(db: pg.Pool, contactId: string): Promise<number> {
  const r = await db.query<{ dial_rotation_ordinal: number }>(
    `select dial_rotation_ordinal from crm.contacts where id = $1`,
    [contactId],
  );
  return r.rows[0].dial_rotation_ordinal;
}

async function loadContact(db: pg.Pool, id: string): Promise<ContactRow> {
  // 🚨 EXACTLY THE COLUMNS THAT SURVIVE MIGRATION 022's revoke. Adding
  // email_address / source_detail / looking_for back is a 42501 under `switchboard_crm`
  // — details are the sheet's, read live, or honestly null for a manual contact.
  const r = await db.query<ContactRow>(
    `select id, tenant_id, display_name, channel, follow_up_interval_days,
            linked_sheet_id, row_ref
       from crm.contacts where id = $1`,
    [id],
  );
  if (r.rowCount !== 1) throw new Error(`no such contact: ${id}`);
  return r.rows[0];
}

async function loadNumbers(db: pg.Pool, contactId: string): Promise<NumberRow[]> {
  const r = await db.query<NumberRow>(
    `select id, phone_e164, ordinal from crm.phone_numbers
      where contact_id = $1 order by ordinal`,
    [contactId],
  );
  return r.rows;
}

async function loadSettings(db: pg.Pool, tenantId: string): Promise<SettingsRow> {
  const r = await db.query<SettingsRow>(
    `select timezone, opening_line, opening_line_no_name, default_interval_days
       from crm.outreach_settings where tenant_id = $1`,
    [tenantId],
  );
  if (r.rowCount !== 1) {
    throw new Error(
      `no outreach settings for tenant ${tenantId} — the two intervals and both opening ` +
        `lines are HERS and have no default. Nothing may be proposed until she sets them.`,
    );
  }
  return r.rows[0];
}
