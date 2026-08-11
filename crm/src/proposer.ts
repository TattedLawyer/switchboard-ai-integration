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
import { claimDue, type ClaimedContact } from "./claim.js";
import {
  blockFollowUp,
  hasOpenFollowUpBefore,
  openFollowUp,
  type BlockedReason,
} from "./followups.js";
import { renderOpening } from "./opening.js";
import { selectQuestionSetForProposal } from "./questions.js";

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

interface ContactRow {
  id: string;
  tenant_id: string;
  display_name: string | null;
  email_address: string | null;
  channel: "call" | "email" | "both" | "none";
  source_detail: string | null;
  looking_for: string | null;
  follow_up_interval_days: number | null;
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
  const out: ContactOutcome[] = [];
  for (const c of claimed) {
    out.push(await proposeForClaimed(deps, tenantId, c));
  }
  return out;
}

export async function proposeForClaimed(
  deps: ProposerDeps,
  tenantId: string,
  claimed: ClaimedContact,
): Promise<ContactOutcome> {
  const { db } = deps;
  const settings = await loadSettings(db, tenantId);
  const dueDate = dueDateIn(claimed.claimedDueAt, settings.timezone);
  const contact = await loadContact(db, claimed.id);

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

  const channels: Channel[] =
    contact.channel === "both"
      ? ["call", "email"]
      : contact.channel === "none"
        ? []
        : [contact.channel];

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
        ? buildCallProposal(db, tenantId, contact, settings, idempotencyKey(contact.id, dueDate, channel))
        : Promise.resolve(buildEmailProposal(contact, idempotencyKey(contact.id, dueDate, channel))),
  }));
  const resolved = await Promise.all(
    legs.map(async (l) => ({ channel: l.channel, result: await l.build })),
  );
  const buildable = resolved.filter((l) => l.result.ok);

  if (buildable.length === 0) {
    // Every wanted leg failed. Pick the PRIMARY block reason — a call-arm data gap
    // (`no_phone_number` / `no_question_set`) outranks the email-arm one, so a `both` with no
    // address surfaces the more actionable gap. `channel = 'none'` yields no legs and is not a
    // data gap she can fix, so it blocks nothing and simply returns.
    const reasons = resolved.flatMap((l) => (!l.result.ok ? [l.result.blockReason] : []));
    const primary =
      reasons.find((r) => r === "no_phone_number") ??
      reasons.find((r) => r === "no_question_set") ??
      reasons.find((r) => r === "no_email_address") ??
      null;
    if (primary === null) {
      return { contactId: contact.id, dueDate, actions: [], blockedReason: null, skipped: [] };
    }
    await blockFollowUp(db, contact.id, dueDate, primary);
    return {
      contactId: contact.id,
      dueDate,
      actions: [],
      blockedReason: primary,
      skipped: resolved
        .filter((l) => !l.result.ok)
        .map((l) => ({ channel: l.channel, reason: (l.result as LegFail).blockReason })),
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
      skipped.push({ channel: leg.channel, reason: leg.result.blockReason });
      continue;
    }
    const built = leg.result;
    const key = idempotencyKey(contact.id, dueDate, leg.channel);
    const { id } = await deps.postProposal(built.proposal);
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
  blockReason: BlockedReason;
}
type LegBuild = BuiltProposal | LegFail;

async function buildCallProposal(
  db: pg.Pool,
  tenantId: string,
  contact: ContactRow,
  settings: SettingsRow,
  key: string,
): Promise<LegBuild> {
  const numbers = await loadNumbers(db, contact.id);
  if (numbers.length === 0) return { ok: false, blockReason: "no_phone_number" };
  const set = await selectQuestionSetForProposal(db, tenantId);
  if (set === null) return { ok: false, blockReason: "no_question_set" };

  // 🚨 MODULO THE LIVE COUNT, never the stored ordinal used as an array index. She deletes
  // a number and the stored rotation index is suddenly past the end — an index straight
  // into the array either crashes or skips the whole list.
  const rotation = await currentRotation(db, contact.id);
  const pick = numbers[rotation % numbers.length];

  const opening = renderOpening(contact.display_name, {
    openingLine: settings.opening_line,
    openingLineNoName: settings.opening_line_no_name,
  });

  const last = await lastTouchSummary(db, contact.id);
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
        display_name: contact.display_name,
        opening_line: opening.line,
        question_set_id: set.id,
        context: {
          source_detail: contact.source_detail,
          looking_for: contact.looking_for,
        },
      },
      // 🚨 WHY THIS CONTACT, WHY NOW, WHICH NUMBER. A constant rationale is "an instruction
      // wearing a proposal's clothes" (proposal.ts:38-39) — the human cannot judge an ask
      // that does not say what it is.
      rationale:
        `${contact.display_name ?? "This number has no name on file"} is due: ` +
        `${last} · follow-up interval ${intervalDays} days · ` +
        `calling ${pick.phone_e164} (entry ${pick.ordinal + 1} of ${numbers.length}).` +
        (opening.path === "nameless"
          ? " No name on file, so the agent opens as an associate of yours and the answers " +
            "will be stored labelled identity-unverified."
          : ""),
    },
  };
}

function buildEmailProposal(contact: ContactRow, key: string): LegBuild {
  // 🚨 EMAIL PREFERRED, NO ADDRESS ON FILE is a BLOCK, not a fall-back to calling —
  // overriding her stated preference at the moment we have least information is the worst
  // available outcome. The email leg simply fails to build; whether that becomes a blocked
  // row depends (Option B) on whether any OTHER leg built.
  if (contact.email_address === null || contact.email_address === "") {
    return { ok: false, blockReason: "no_email_address" };
  }
  const who = contact.display_name ?? "there";
  return {
    ok: true,
    proposal: {
      idempotency_key: key,
      action_type: "send_email",
      payload: {
        contact_id: contact.id,
        to: contact.email_address,
        subject: "Following up",
        body:
          `Hi ${who} — just following up on our conversation` +
          (contact.looking_for ? ` about ${contact.looking_for}` : "") +
          `. Is now a good time to talk?`,
      },
      rationale:
        `${who} is due and prefers email` +
        (contact.source_detail ? ` (met at ${contact.source_detail})` : "") +
        `. Single message, no sequence.`,
    },
  };
}

async function lastTouchSummary(db: pg.Pool, contactId: string): Promise<string> {
  const r = await db.query<{ occurred_at: Date; disposition: string | null }>(
    `select occurred_at, disposition from crm.touches
      where contact_id = $1 order by occurred_at desc limit 1`,
    [contactId],
  );
  if (r.rowCount !== 1) return "never contacted";
  const d = r.rows[0];
  return `last contacted ${d.occurred_at.toISOString().slice(0, 10)} (${d.disposition ?? "in progress"})`;
}

async function currentRotation(db: pg.Pool, contactId: string): Promise<number> {
  const r = await db.query<{ dial_rotation_ordinal: number }>(
    `select dial_rotation_ordinal from crm.contacts where id = $1`,
    [contactId],
  );
  return r.rows[0].dial_rotation_ordinal;
}

async function loadContact(db: pg.Pool, id: string): Promise<ContactRow> {
  const r = await db.query<ContactRow>(
    `select id, tenant_id, display_name, email_address, channel, source_detail,
            looking_for, follow_up_interval_days
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
