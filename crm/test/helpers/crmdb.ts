// Shared fixtures for the CRM suites.
//
// Two pools, always, and the difference is the point: `admin` is the MIGRATION OWNER (what
// the operator CLIs connect as — intake, question editor, settings) and `crm` is
// `switchboard_crm` (what the proposer and the executor connect as). A fixture that builds
// state through the owner pool when the running system would build it through the CRM role
// is testing a universe the shipped code cannot reach — the failure class that let A2's
// forged-state fixtures survive seven reviews.
import pg from "pg";
import { freshTestDb } from "../../../ingest/test/helpers/testdb.js";

export const TEST_TENANT = "00000000-0000-0000-0000-0000000000c1";

/**
 * A FIXED instant, safely mid-Manila-day: 03:00Z = 11:00 Asia/Manila. Fixtures that need
 * "a real moment in time" seed from THIS (driving production clocks via the injected
 * `now`), never from the machine clock. A fixture seeded from `new Date()` near Manila
 * midnight silently stops constructing the scenario it names — a 15-minute lease crosses
 * the Manila date line and "same date" becomes "next date" (the defect family behind the
 * 2026-08-16 sweep; see date-idiom.pin.test.ts).
 */
export const TEST_INSTANT = new Date("2026-03-03T03:00:00Z");

/**
 * The guard boundary AFTER a follow-up's own due date, derived from the row's read-back
 * `due_date` (a Manila calendar date, `YYYY-MM-DD`) with pure calendar arithmetic — NO
 * clock. `hasOpenFollowUpBefore(db, contact, dayAfter(dueDate))` can therefore see an open
 * row at that due date at ANY wall-clock hour; the previous idiom
 * (UTC-rendered "now + 1 day") drifted one day behind Manila from 16:00 UTC to midnight,
 * turning the boundary blind — and the assertions on it vacuous — eight hours a day.
 */
export function dayAfter(dueDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate);
  if (!m) throw new Error(`dayAfter expects YYYY-MM-DD, got: ${dueDate}`);
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

export interface CrmDb {
  /** Migration owner. The operator CLIs' role. */
  admin: pg.Pool;
  /** `switchboard_crm`. The proposer's and executor's role. */
  crm: pg.Pool;
  url: string;
  cleanup: () => Promise<void>;
}

export async function freshCrmDb(): Promise<CrmDb> {
  const r = await freshTestDb();
  const u = new URL(r.url);
  u.username = "switchboard_crm";
  u.password = "switchboard_crm";
  const crm = new pg.Pool({ connectionString: u.toString(), max: 6 });
  crm.on("error", () => {});
  return {
    admin: r.pool,
    crm,
    url: r.url,
    cleanup: async () => {
      await crm.end().catch(() => {});
      await r.cleanup();
    },
  };
}

/** The SQLSTATE of a thrown pg error. §4: assert the SQLSTATE, never a bare `toThrow()` —
 *  A2's T3 pin was sensitive only when asserting `42501`, and a widened grant produced
 *  `P0001` while a bare `toThrow()` stayed green. */
export async function sqlstate(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return String((err as { code?: string }).code ?? `NO-CODE:${String(err)}`);
  }
  return "NO-ERROR";
}

export interface SeedContactOptions {
  displayName?: string | null;
  email?: string | null;
  channel?: "call" | "email" | "both" | "none";
  active?: boolean;
  intervalDays?: number | null;
  dueAt?: string | null;
  tenant?: string;
}

/** Created through the OWNER pool, because that is what `crm-contact-add` does. */
export async function seedContact(
  admin: pg.Pool,
  o: SeedContactOptions = {},
): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `insert into crm.contacts
       (tenant_id, display_name, email_address, channel, source, source_detail,
        looking_for, active, follow_up_interval_days, next_due_at)
     values ($1, $2, $3, $4, 'referral', 'Rotary breakfast', 'a 2BR near Alabang',
             $5, $6, $7)
     returning id`,
    [
      o.tenant ?? TEST_TENANT,
      o.displayName === undefined ? "Ana Reyes" : o.displayName,
      o.email ?? null,
      o.channel ?? "call",
      o.active ?? true,
      o.intervalDays ?? null,
      o.dueAt === undefined ? new Date().toISOString() : o.dueAt,
    ],
  );
  return r.rows[0].id;
}

export async function seedNumber(
  admin: pg.Pool,
  contactId: string,
  e164: string,
  ordinal = 0,
  raw = e164,
): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `insert into crm.phone_numbers (contact_id, phone_e164, phone_raw, ordinal)
     values ($1, $2, $3, $4) returning id`,
    [contactId, e164, raw, ordinal],
  );
  return r.rows[0].id;
}

export interface SeedQuestionSet {
  setId: string;
  questionIds: string[];
}

export async function seedQuestionSet(
  admin: pg.Pool,
  prompts: Array<[key: string, text: string]> = [
    ["budget", "What budget range are you working with?"],
    ["timeline", "When are you hoping to move?"],
  ],
  version = 1,
  tenant = TEST_TENANT,
): Promise<SeedQuestionSet> {
  const s = await admin.query<{ id: string }>(
    `insert into crm.question_sets (tenant_id, version) values ($1, $2) returning id`,
    [tenant, version],
  );
  const setId = s.rows[0].id;
  const questionIds: string[] = [];
  for (const [i, [key, text]] of prompts.entries()) {
    const q = await admin.query<{ id: string }>(
      `insert into crm.questions (set_id, ordinal, question_key, prompt_text, answer_kind)
       values ($1, $2, $3, $4, 'text') returning id`,
      [setId, i, key, text],
    );
    questionIds.push(q.rows[0].id);
  }
  return { setId, questionIds };
}

export interface SeedSettings {
  windowStart?: string;
  windowEnd?: string;
  timezone?: string;
  openingLine?: string;
  openingLineNoName?: string;
  intervalDays?: number;
  shortRetryDays?: number;
  tenant?: string;
}

export async function seedSettings(admin: pg.Pool, o: SeedSettings = {}): Promise<void> {
  await admin.query(
    `insert into crm.outreach_settings
       (tenant_id, window_start, window_end, timezone, opening_line,
        opening_line_no_name, default_interval_days, short_retry_days)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (tenant_id) do update set
       window_start = excluded.window_start, window_end = excluded.window_end,
       timezone = excluded.timezone, opening_line = excluded.opening_line,
       opening_line_no_name = excluded.opening_line_no_name,
       default_interval_days = excluded.default_interval_days,
       short_retry_days = excluded.short_retry_days`,
    [
      o.tenant ?? TEST_TENANT,
      o.windowStart ?? "09:00",
      o.windowEnd ?? "18:00",
      o.timezone ?? "Asia/Manila",
      o.openingLine ??
        "Hi, this is Marisol's assistant from Alabang Realty. May I speak with {name}?",
      o.openingLineNoName ??
        "Hi, I'm an associate of Marisol Cruz at Alabang Realty — do you have a moment?",
      o.intervalDays ?? 30,
      o.shortRetryDays ?? 3,
    ],
  );
}

/** A touch in the SHIPPED ORDER: inserted at call start, `transcript_delivery='pending'`,
 *  disposition NULL. Any fixture that sets a disposition at insert is testing an ordering
 *  the system does not run — round 2's surviving blocker. */
export async function startTouch(
  db: pg.Pool,
  contactId: string,
  o: { channel?: "call" | "email"; phoneNumberId?: string | null; questionSetId?: string | null } = {},
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into crm.touches
       (contact_id, channel, phone_number_id, question_set_id, transcript_delivery)
     values ($1, $2, $3, $4, 'pending') returning id`,
    [contactId, o.channel ?? "call", o.phoneNumberId ?? null, o.questionSetId ?? null],
  );
  return r.rows[0].id;
}
