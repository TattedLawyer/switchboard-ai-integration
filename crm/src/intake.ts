// Core loop / T3 — capture. The first step of the loop, and the one the client already
// does badly: she takes a number at a networking event and it goes nowhere.
//
// 🚨 INTAKE REFUSES ALMOST NOTHING, AND THAT IS THE DESIGN. The failure being fixed is a
// LOST LEAD. A validation that rejects a capture because a field is not filled in yet
// converts a recoverable gap into the exact outcome the product exists to prevent — so a
// contact whose channel is `email` and whose address she has not typed yet is ACCEPTED, and
// the missing address surfaces later as a blocked follow-up she can see and fix (§5.4).
// The one thing that IS refused is a phone number we cannot read, because storing a number
// nobody can dial is not a capture, it is a silent loss with a row attached.
//
// Runs as the MIGRATION OWNER (016's §I-3 table): these are operator CLIs, human-invoked,
// like `approval-user-add`. `switchboard_crm` gets `42501` here and that is pinned.
import type pg from "pg";
import { normalizePhone, isPhoneError, DEFAULT_REGION } from "./phone.js";

export type Channel = "call" | "email" | "both" | "none";
export type Source = "event" | "referral" | "manual";

export interface AddContactInput {
  tenantId: string;
  /** NULLABLE. A number with no name is still called — the agent introduces itself as an
   *  associate of the broker (§5.6). A missing field must never cost her a follow-up. */
  displayName?: string | null;
  emailAddress?: string | null;
  channel: Channel;
  source: Source;
  sourceDetail?: string | null;
  lookingFor?: string | null;
  /** Left NULL unless she overrides it for this one person. See `due.ts`. */
  followUpIntervalDays?: number | null;
}

export interface AddedContact {
  id: string;
  nextDueAt: Date;
}

/**
 * Capture a contact. `next_due_at = now()`: A NEWLY CAPTURED LEAD IS DUE IMMEDIATELY, which
 * is precisely the client's stated failure — the number sits in a notebook and the first
 * follow-up never happens.
 */
export async function addContact(db: pg.Pool, input: AddContactInput): Promise<AddedContact> {
  const r = await db.query<{ id: string; next_due_at: Date }>(
    `insert into crm.contacts
       (tenant_id, display_name, email_address, channel, source, source_detail,
        looking_for, follow_up_interval_days, next_due_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())
     returning id, next_due_at`,
    [
      input.tenantId,
      input.displayName ?? null,
      input.emailAddress ?? null,
      input.channel,
      input.source,
      input.sourceDetail ?? null,
      input.lookingFor ?? null,
      // 🚨 NEVER the tenant default. NULL means "hers, whatever it is at the moment we
      // compute the next due date" — see `due.ts`.
      input.followUpIntervalDays ?? null,
    ],
  );
  return { id: r.rows[0].id, nextDueAt: r.rows[0].next_due_at };
}

export interface AddNumberResult {
  id: string;
  e164: string;
  /** What is stored — which for a re-add is the FIRST form she typed, not this one. */
  phoneRaw: string;
  /** true when this number was already on the contact in some other format. */
  alreadyPresent: boolean;
  ordinal: number;
}

export type AddNumberOutcome = AddNumberResult | { error: string };

/**
 * Add a number to a contact.
 *
 * 🚨 DEDUPLICATION IS ON `phone_e164`, NEVER ON `phone_raw`. "0917-123-4567" and
 * "+63 917 123 4567" are the same line; keyed on the raw text they become two rows, the
 * rotation then dials the same line twice in two cycles, and she looks like she is
 * pestering a referral. E.164 is what the machine compares; `phone_raw` is what she reads.
 *
 * ON A RE-ADD THE FIRST `phone_raw` IS PRESERVED. She recognises her own handwriting;
 * overwriting it with a later paste makes the listing stop looking like hers for no gain.
 *
 * Ordinal is `max + 1` — DIAL ORDER IS THE ORDER SHE ENTERED THEM (§5.1). First entered is
 * primary. The free-text `label` is for her eyes and the machine never reads it.
 */
export async function addNumber(
  db: pg.Pool,
  contactId: string,
  raw: string,
  opts: { label?: string | null; region?: string } = {},
): Promise<AddNumberOutcome> {
  const region = opts.region ?? DEFAULT_REGION;
  const parsed = normalizePhone(raw, region);
  if (isPhoneError(parsed)) return { error: parsed.error };

  const client = await db.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{ id: string; phone_raw: string; ordinal: number }>(
      `select id, phone_raw, ordinal from crm.phone_numbers
        where contact_id = $1 and phone_e164 = $2`,
      [contactId, parsed.e164],
    );
    if (existing.rowCount === 1) {
      await client.query("commit");
      return {
        id: existing.rows[0].id,
        e164: parsed.e164,
        phoneRaw: existing.rows[0].phone_raw,
        alreadyPresent: true,
        ordinal: existing.rows[0].ordinal,
      };
    }
    const ins = await client.query<{ id: string; ordinal: number }>(
      `insert into crm.phone_numbers (contact_id, phone_e164, phone_raw, phone_region, label, ordinal)
       select $1, $2, $3, $4, $5,
              coalesce(max(p.ordinal) + 1, 0) from crm.phone_numbers p where p.contact_id = $1
       returning id, ordinal`,
      [contactId, parsed.e164, parsed.raw, region, opts.label ?? null],
    );
    await client.query("commit");
    return {
      id: ins.rows[0].id,
      e164: parsed.e164,
      phoneRaw: parsed.raw,
      alreadyPresent: false,
      ordinal: ins.rows[0].ordinal,
    };
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function isAddNumberError(r: AddNumberOutcome): r is { error: string } {
  return "error" in r;
}
