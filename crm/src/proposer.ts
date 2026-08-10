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
  hasOpenFollowUp,
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
  const claimed = await claimDue(deps.db, tenantId, limit);
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

  // The open-guard. A contact already mid-cycle is not proposed again, even if her clock
  // was moved backwards. Blocked rows deliberately do not count (B4).
  if (await hasOpenFollowUp(db, contact.id)) {
    return {
      contactId: contact.id,
      dueDate,
      actions: [],
      blockedReason: null,
      skipped: [{ channel: "call", reason: "an open follow-up already exists" }],
    };
  }

  const channels: Channel[] =
    contact.channel === "both"
      ? ["call", "email"]
      : contact.channel === "none"
        ? []
        : [contact.channel];

  const wantsEmail = channels.includes("email");
  const canEmail = contact.email_address !== null && contact.email_address !== "";

  // 🚨 EMAIL PREFERRED, NO ADDRESS ON FILE. It must NOT fall back to calling — overriding
  // her stated preference at the moment we have least information is the worst available
  // outcome — and it must not silently drop, which is the original failure. So: a BLOCKED
  // follow-up, surfaced (T13), and the clock untouched.
  if (wantsEmail && !canEmail && contact.channel === "email") {
    await blockFollowUp(db, contact.id, dueDate, "no_email_address");
    return {
      contactId: contact.id,
      dueDate,
      actions: [],
      blockedReason: "no_email_address",
      skipped: [{ channel: "email", reason: "no email address on file" }],
    };
  }

  const followUp = await openFollowUp(db, contact.id, dueDate);
  const actions: ProposedAction[] = [];
  const skipped: ContactOutcome["skipped"] = [];

  for (const channel of channels) {
    if (channel === "email" && !canEmail) {
      // A `both` contact with no address yet. The CALL still happens — her stated
      // preference included it — and the email arm is skipped rather than substituted.
      // DISCLOSED: this arm is visible in the cycle's return value and in the absence of an
      // `email` row in `crm.follow_up_actions`, but it is NOT one of T13's four reconcile
      // listings, so it is not surfaced to her. The plan does not settle `both` + no
      // address, and inventing a fifth reconcile listing to cover it would contradict a
      // pin that says exactly four.
      skipped.push({ channel, reason: "no email address on file (call arm proceeds)" });
      continue;
    }
    const key = idempotencyKey(contact.id, dueDate, channel);
    const built =
      channel === "call"
        ? await buildCallProposal(db, tenantId, contact, settings, key)
        : buildEmailProposal(contact, key);
    if (built === null) {
      skipped.push({ channel, reason: "nothing to propose" });
      continue;
    }
    const { id } = await deps.postProposal(built.proposal);
    await db.query(
      `insert into crm.follow_up_actions (follow_up_id, channel, proposal_id)
       values ($1, $2, $3)
       on conflict (follow_up_id, channel) do nothing`,
      [followUp.id, channel, id],
    );
    actions.push({
      channel,
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
  proposal: DoorProposal;
  phoneE164?: string;
  identityUnverified?: boolean;
}

async function buildCallProposal(
  db: pg.Pool,
  tenantId: string,
  contact: ContactRow,
  settings: SettingsRow,
  key: string,
): Promise<BuiltProposal | null> {
  const numbers = await loadNumbers(db, contact.id);
  if (numbers.length === 0) return null;
  const set = await selectQuestionSetForProposal(db, tenantId);
  if (set === null) return null;

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

function buildEmailProposal(contact: ContactRow, key: string): BuiltProposal {
  const who = contact.display_name ?? "there";
  return {
    proposal: {
      idempotency_key: key,
      action_type: "send_email",
      payload: {
        contact_id: contact.id,
        to: contact.email_address as string,
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
