// The one-command path to the first real phone call — the LOGIC behind
// `scripts/crm-call-test.ts`, kept here so the compiler and the pins can both see it (the
// same split as `selectApprovedActions` vs `scripts/executor-loop.ts`, and for the same
// reason: script code sits outside every tsconfig, and a real bug shipped there because
// no typecheck ever saw it).
//
// WHAT THIS SEEDS, given a phone number and a tenant: a contact carrying that number, a
// minimal question set (only if she has none — HER current set is reused, never retired),
// outreach settings whose window is OPEN NOW (only widened if hers is closed, and the
// result says so), and a `place_call` proposal created and approved THROUGH THE REAL SPINE
// — a real `approval.proposals` row under the real grammar and hash, a real
// `approval.decisions` row naming a real approver, the 015 trigger adjudicating the state
// move. The running executor daemon then picks it up with its own `selectApprovedActions`.
//
// 🚨 TWO REFUSALS COME BEFORE ANY DATABASE WORK, in this order:
//   1. the PHONE ALLOWLIST (Piece 1, `call-guard.ts`): a number not on
//      SWITCHBOARD_PHONE_ALLOWLIST is refused by name, fail-closed — this tool exists to
//      place a TEST call, and a test call to a number the deployment may not dial is not
//      a test, it is the incident;
//   2. the DATABASE NAME: a database named `switchboard` is refused outright — the same
//      guard `scripts/executor-loop.ts` carries, because a seeding tool that works
//      perfectly against the database we pledged never to deliberately write is the
//      failure the plan review ranked most dangerous.
//
// 🚨 THE A2 SPINE IS INJECTED, NOT IMPORTED (`CallTestSpine`). `crm/src` may not import
// `approval/src`; the wrapper script is the composition root that wires the real
// `payloadHash`, the real `placeCallPayloadSchema` and the real `decide` in — exactly the
// `ApprovalSpine` arrangement `executor.ts` already established.
//
// This is OPERATOR TOOLING: it connects as the MIGRATION OWNER (db.ts §I-3 — the same
// pool every other `crm-*` CLI uses), because seeding contacts, questions and settings is
// owner territory (016/021's grant blocks make it `42501` under `switchboard_crm`).
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { checkCallable } from "./call-guard.js";
import { normalizePhone, isPhoneError } from "./phone.js";
import { addContact, addNumber, isAddNumberError } from "./intake.js";
import { currentQuestionSet, publishQuestionSet } from "./questions.js";
import { renderOpening } from "./opening.js";
import { isWithinWindow } from "./gates.js";

/** The real approval-side functions, wired in by the composition root. */
export interface CallTestSpine {
  /** `approval/src/canonical.ts` — the hash the door stores and the card attests. */
  payloadHash: (payload: Record<string, unknown>) => string;
  /** `placeCallPayloadSchema.safeParse`, wrapped — the seeded payload must parse under
   *  the REAL grammar or nothing is inserted. */
  parsePayload: (
    input: unknown,
  ) => { ok: true; value: unknown } | { ok: false; problem: string };
  /** `approval/src/decide.ts` — the real decision path: append-only decision row, 015
   *  trigger, attributed approver. */
  decide: (
    pool: pg.Pool,
    req: { proposalId: string; kind: "approved"; approverUserId: string },
  ) => Promise<unknown>;
  /** `PROPOSAL_TTL_HOURS` — the door's TTL, so the seeded card expires like a real one. */
  proposalTtlHours: number;
}

export interface CallTestOptions {
  tenantId: string;
  /** The number to call, as typed — normalised exactly as `crm-number-add` normalises. */
  phone: string;
  /** Explicit null seeds a NAMELESS contact (the §5.6 path). Default: "Call Test". */
  displayName?: string | null;
  /** 🚨 INJECTED (parsed from SWITCHBOARD_PHONE_ALLOWLIST at the CLI edge), never read
   *  from `process.env` here — the call-guard doctrine. Empty refuses everything. */
  phoneAllowlist: readonly string[];
  now?: () => Date;
}

export interface CallTestSeeded {
  contactId: string;
  phoneNumberId: string;
  phoneE164: string;
  questionSetId: string;
  questionPrompts: string[];
  questionSetCreated: boolean;
  openingLine: string;
  proposalId: string;
  approverUserId: string;
  window: { start: string; end: string; timezone: string };
  windowAdjusted: boolean;
  settingsCreated: boolean;
  expiresAt: Date;
}

/** The identity the auto-approval is recorded under. A visible, greppable marker: every
 *  decision this tool makes names it, so "who approved that?" has an honest answer. */
export const CALL_TEST_APPROVER_EMAIL = "call-test-operator@switchboard.invalid";

const OPEN_ALL_DAY = { start: "00:00", end: "23:59" };

/** The minimal question set published ONLY when the tenant has none. Three questions —
 *  enough to hear the agent work through a list, nothing that pretends to be her script. */
const TEST_QUESTIONS = [
  { key: "test_line_quality", prompt: "How does the line sound on your end?", kind: "text" },
  { key: "test_opening_heard", prompt: "Did you hear the opening line clearly?", kind: "text" },
  { key: "test_wrap_up", prompt: "Anything you want the agent to repeat back?", kind: "text" },
] as const;

export async function seedCallTest(
  ownerDb: pg.Pool,
  spine: CallTestSpine,
  o: CallTestOptions,
): Promise<CallTestSeeded> {
  const now = o.now?.() ?? new Date();

  // ── 1. THE NUMBER, before anything else. Pure: nothing has touched the database yet.
  const parsed = normalizePhone(o.phone);
  if (isPhoneError(parsed)) {
    throw new Error(`${parsed.error} — nothing was seeded.`);
  }
  const callable = checkCallable(parsed.e164, o.phoneAllowlist);
  if (!callable.ok) {
    throw new Error(
      `refusing to seed a test call: ${callable.reason}. Nothing was seeded — this tool ` +
        `will only dial numbers on SWITCHBOARD_PHONE_ALLOWLIST (fail-closed).`,
    );
  }

  // ── 2. THE DATABASE NAME — the first query, before any write (executor-loop's guard).
  const dbName = (
    await ownerDb.query<{ d: string }>("select current_database() as d")
  ).rows[0].d;
  if (dbName === "switchboard") {
    throw new Error(
      "refusing to run against the named `switchboard` database — this tool seeds rows, " +
        "and that database is the one this repo pledged never to deliberately write.",
    );
  }

  // ── 3. Outreach settings with a window that is OPEN NOW. Hers are preserved wherever
  //       possible: created only if absent, and only the WINDOW is widened if closed —
  //       opening lines and intervals are her configuration, not ours to invent over.
  let settingsCreated = false;
  let windowAdjusted = false;
  const existing = await ownerDb.query<{
    window_start: string;
    window_end: string;
    timezone: string;
    opening_line: string;
    opening_line_no_name: string;
  }>(
    `select window_start, window_end, timezone, opening_line, opening_line_no_name
       from crm.outreach_settings where tenant_id = $1`,
    [o.tenantId],
  );
  if (existing.rowCount === 0) {
    await ownerDb.query(
      `insert into crm.outreach_settings
         (tenant_id, window_start, window_end, timezone, opening_line,
          opening_line_no_name, default_interval_days, short_retry_days)
       values ($1, $2, $3, 'Asia/Manila', $4, $5, 30, 3)`,
      [
        o.tenantId,
        OPEN_ALL_DAY.start,
        OPEN_ALL_DAY.end,
        "Hi {name}, this is a Switchboard test call — checking the line works end to end.",
        "Hi, this is a Switchboard test call — checking the line works end to end.",
      ],
    );
    settingsCreated = true;
  } else {
    const w = existing.rows[0];
    const open = isWithinWindow(now, {
      windowStart: w.window_start,
      windowEnd: w.window_end,
      timezone: w.timezone,
    });
    if (!open) {
      await ownerDb.query(
        `update crm.outreach_settings set window_start = $2, window_end = $3
          where tenant_id = $1`,
        [o.tenantId, OPEN_ALL_DAY.start, OPEN_ALL_DAY.end],
      );
      windowAdjusted = true;
    }
  }
  const settings = (
    await ownerDb.query<{
      window_start: string;
      window_end: string;
      timezone: string;
      opening_line: string;
      opening_line_no_name: string;
    }>(
      `select window_start, window_end, timezone, opening_line, opening_line_no_name
         from crm.outreach_settings where tenant_id = $1`,
      [o.tenantId],
    )
  ).rows[0];

  // ── 4. The contact and its number, through the SAME functions the intake CLIs use.
  const displayName = o.displayName === undefined ? "Call Test" : o.displayName;
  const contact = await addContact(ownerDb, {
    tenantId: o.tenantId,
    displayName,
    emailAddress: null,
    channel: "call",
    source: "manual",
    sourceDetail: "crm-call-test CLI",
    lookingFor: null,
    followUpIntervalDays: null,
  });
  const number = await addNumber(ownerDb, contact.id, o.phone, { label: "call-test" });
  if (isAddNumberError(number)) {
    throw new Error(`${number.error} — contact ${contact.id} was created without a number.`);
  }

  // ── 5. The question set: HERS if she has one (reused, never retired); a minimal
  //       3-question set only when none exists.
  let set = await currentQuestionSet(ownerDb, o.tenantId);
  let questionSetCreated = false;
  if (set === null) {
    const published = await publishQuestionSet(ownerDb, o.tenantId, [...TEST_QUESTIONS]);
    questionSetCreated = true;
    set = await currentQuestionSet(ownerDb, o.tenantId);
    if (set === null || set.id !== published.setId) {
      throw new Error("published a question set and could not read it back — aborting");
    }
  }

  // ── 6. The payload, exactly the shape the proposer builds, validated under the REAL
  //       grammar before anything is inserted.
  const opening = renderOpening(displayName, {
    openingLine: settings.opening_line,
    openingLineNoName: settings.opening_line_no_name,
  });
  const payload: Record<string, unknown> = {
    contact_id: contact.id,
    phone_number_id: number.id,
    phone_e164: number.e164,
    display_name: displayName,
    opening_line: opening.line,
    question_set_id: set.id,
    context: { source_detail: "crm-call-test CLI", looking_for: null },
  };
  const parse = spine.parsePayload(payload);
  if (!parse.ok) {
    throw new Error(
      `the seeded payload does not parse under placeCallPayloadSchema — nothing was ` +
        `proposed: ${parse.problem}`,
    );
  }

  // ── 7. The proposal, mirroring the door's INSERT (state 'pending' by default, the
  //       door's TTL), then the REAL decision path. The 015 trigger adjudicates the move.
  const proposal = await ownerDb.query<{ id: string; expires_at: Date }>(
    `insert into approval.proposals
       (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash,
        expires_at)
     values ($1, $2, 'place_call', $3::jsonb, $4, $5,
             now() + make_interval(hours => $6::int))
     returning id, expires_at`,
    [
      o.tenantId,
      `call-test-${randomUUID()}`,
      JSON.stringify(payload),
      "operator-initiated test call (crm-call-test CLI)",
      spine.payloadHash(payload),
      spine.proposalTtlHours,
    ],
  );
  const proposalId = proposal.rows[0].id;

  const approver = await ownerDb.query<{ id: string }>(
    `select id from approval.users where lower(email) = lower($1) and disabled_at is null`,
    [CALL_TEST_APPROVER_EMAIL],
  );
  const approverUserId =
    approver.rowCount === 1
      ? approver.rows[0].id
      : (
          await ownerDb.query<{ id: string }>(
            `insert into approval.users (email) values ($1) returning id`,
            [CALL_TEST_APPROVER_EMAIL],
          )
        ).rows[0].id;

  await spine.decide(ownerDb, { proposalId, kind: "approved", approverUserId });

  const state = await ownerDb.query<{ state: string }>(
    `select state from approval.proposals where id = $1`,
    [proposalId],
  );
  if (state.rows[0]?.state !== "approved") {
    throw new Error(
      `the proposal did not land in 'approved' (it is '${state.rows[0]?.state ?? "gone"}') — ` +
        `the executor will not pick it up`,
    );
  }

  return {
    contactId: contact.id,
    phoneNumberId: number.id,
    phoneE164: number.e164,
    questionSetId: set.id,
    questionPrompts: set.questions.map((q) => q.promptText),
    questionSetCreated,
    openingLine: opening.line,
    proposalId,
    approverUserId,
    window: {
      start: settings.window_start,
      end: settings.window_end,
      timezone: settings.timezone,
    },
    windowAdjusted,
    settingsCreated,
    expiresAt: proposal.rows[0].expires_at,
  };
}
