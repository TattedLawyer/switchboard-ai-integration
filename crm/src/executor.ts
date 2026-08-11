// Core loop / T11 — the call, wired to the A2 execution spine that already exists.
//
// 🚨 THIS BUILDS NO SECOND SPINE. At-most-once is `approval.executions`' partial unique
// index; the state machine is 015's trigger; expiry is enforced inside `beginExecution`'s
// UPDATE predicate as a compare-and-set. This file arranges those in the right order and
// adds the CRM side of the story.
//
// THE ORDER, and each step is where it is for a reason:
//   1. GATE FIRST (T7). The outreach window is checked BEFORE anything moves, so a call
//      refused for being out of hours does not burn the proposal's one permitted start.
//   2. `beginExecution` — the at-most-once claim and the expiry check, in one CAS.
//   3. `beginTouch` — the touch row exists from call start, with `transcript_delivery =
//      'pending'` and a NULL disposition, because answers are committed DURING the call and
//      `crm.answers.touch_id` is a foreign key.
//   4. the call. Answers land as they arrive.
//   5. `finishExecution`, then `recordTouch`.
//
// 🚨 A VENDOR DEATH MID-CALL DOES NOT ROLL BACK THE ANSWERS. What the prospect said before
// the line dropped is TRUE, and it is the only record of it. Wrapping the call in one
// transaction would discard a genuine half-finished questionnaire because the transport
// failed afterwards. The proposal is left `executing` — which 015 documents as having no
// timer-driven exit and no reaper, deliberately — and T13's reconcile lists it.
import type pg from "pg";
import { gateExecution, type OutreachWindow } from "./gates.js";
import { beginTouch, recordTouch, type IntervalSettings } from "./touch.js";
import { recordAnswer } from "./answers.js";
import { resolveDisposition, type ConversationOutcome, type TransportSignal } from "./disposition.js";
import { resolveQuestionSetForExecution } from "./questions.js";

export class CallRefused extends Error {}

// 🚨 THE A2 SPINE IS INJECTED, NOT IMPORTED. `crm/src` may not import `approval/src`: the
// repo forbids cross-workspace imports between `src` trees (test code is the established
// exception, and the composition root wires the real functions in). That constraint turns
// out to be the right shape anyway — it makes the three things this executor borrows from
// A2 explicit and countable, instead of an import list that could quietly grow into a
// second spine's worth of coupling.
//
// The payload GRAMMAR is not duplicated here. `parsePayload` is `placeCallPayloadSchema`'s
// safeParse, handed in: two grammars for one door is exactly the defect `.strict()` exists
// to prevent, one level up.
export interface PlaceCallPayload {
  contact_id: string;
  phone_number_id: string;
  phone_e164: string;
  display_name: string | null;
  opening_line: string;
  question_set_id: string;
  context: { source_detail: string | null; looking_for: string | null };
}

export interface ApprovalSpine {
  /** `approval/src/execute.ts` — the at-most-once claim and the expiry compare-and-set. */
  beginExecution: (db: pg.Pool, proposalId: string) => Promise<unknown>;
  /** `approval/src/execute.ts` — the terminal row and the state move, rowcount-checked. */
  finishExecution: (
    db: pg.Pool,
    proposalId: string,
    outcome: { ok: boolean; vendorReference?: string; error?: string },
  ) => Promise<void>;
  /** `approval/src/proposal.ts` — `placeCallPayloadSchema.safeParse`. */
  parsePayload: (
    input: unknown,
  ) => { ok: true; value: PlaceCallPayload } | { ok: false; problem: string };
}

export interface CallContext {
  touchId: string;
  payload: PlaceCallPayload;
  /** The questions THIS call was approved to ask, in order. */
  prompts: Array<{ id: string; questionKey: string; promptText: string }>;
  /** Commit one answer, now, mid-call. */
  answer: (questionId: string, value: string) => Promise<void>;
  /** How far down the list we have got. */
  reached: (ordinal: number) => Promise<void>;
}

export interface CallResult {
  transport: TransportSignal;
  conversation: ConversationOutcome | null;
  messageLeft?: boolean;
}

/** The vendor seam. Faked in tests; LiveKit + Twilio SIP + Gemini Live behind it (T16). */
export type PlaceCall = (ctx: CallContext) => Promise<CallResult>;

export interface ExecutorDeps {
  /** `switchboard_approval` — the spine. */
  approvalDb: pg.Pool;
  /** `switchboard_crm` — the CRM side. */
  crmDb: pg.Pool;
  placeCall: PlaceCall;
  spine: ApprovalSpine;
  window: OutreachWindow;
  intervals: IntervalSettings;
  now?: () => Date;
}

export interface ExecutedCall {
  proposalId: string;
  touchId: string;
  disposition: string;
  identityUnverified: boolean;
  advancedClock: boolean;
}

export async function executeCall(
  deps: ExecutorDeps,
  proposalId: string,
): Promise<ExecutedCall> {
  const now = deps.now?.() ?? new Date();

  const p = await deps.approvalDb.query<{
    payload: unknown;
    action_type: string;
    created_at: Date;
  }>(`select payload, action_type, created_at from approval.proposals where id = $1`, [
    proposalId,
  ]);
  if (p.rowCount !== 1) throw new CallRefused(`no such proposal: ${proposalId}`);
  if (p.rows[0].action_type !== "place_call") {
    throw new CallRefused(`proposal ${proposalId} is a ${p.rows[0].action_type}, not a call`);
  }
  const parsed = deps.spine.parsePayload(p.rows[0].payload);
  if (!parsed.ok) {
    throw new CallRefused(
      `proposal ${proposalId} carries a payload that would not produce a call: ${parsed.problem}`,
    );
  }
  const payload = parsed.value;

  // 1. THE GATE, before anything moves. Approval on Tuesday does not make a Thursday call
  //    permitted, and a refusal here must not consume the one start the proposal gets.
  const gate = gateExecution({
    channel: "call",
    approvedAt: p.rows[0].created_at,
    now,
    window: deps.window,
  });
  if (!gate.allowed) throw new CallRefused(gate.reason ?? "refused by the outreach window");

  // 2. The at-most-once claim AND the expiry check, in one compare-and-set.
  await deps.spine.beginExecution(deps.approvalDb, proposalId);

  // 3. The touch exists from call start.
  const set = await resolveQuestionSetForExecution(deps.crmDb, payload.question_set_id);
  if (set === null) {
    // The bound version vanished — not something retirement can cause (retirement gates
    // SELECTION, never EXECUTION), so this is a real anomaly.
    await deps.spine.finishExecution(deps.approvalDb, proposalId, {
      ok: false,
      error: `question set ${payload.question_set_id} is gone`,
    });
    throw new CallRefused(`question set ${payload.question_set_id} is gone`);
  }
  const touchId = await beginTouch(deps.crmDb, {
    contactId: payload.contact_id,
    channel: "call",
    proposalId,
    phoneNumberId: payload.phone_number_id,
    questionSetId: payload.question_set_id,
  });
  if (payload.display_name === null) {
    // The nameless path (§5.6): answers ARE recorded, and labelled. Written here, at call
    // start, because it is a property of the CALL and not of how it ended.
    await deps.crmDb.query(
      `update crm.touches set identity_unverified = true where id = $1`,
      [touchId],
    );
  }

  const bound = set.questions.map((q) => q.id);

  // 4. The call.
  let result: CallResult;
  try {
    result = await deps.placeCall({
      touchId,
      payload,
      prompts: set.questions.map((q) => ({
        id: q.id,
        questionKey: q.questionKey,
        promptText: q.promptText,
      })),
      answer: async (questionId, value) => {
        await recordAnswer(deps.crmDb, touchId, questionId, value, bound);
      },
      reached: async (ordinal) => {
        await deps.crmDb.query(`update crm.touches set reached_ordinal = $2 where id = $1`, [
          touchId,
          ordinal,
        ]);
      },
    });
  } catch (err) {
    // 🚨 NOTHING IS ROLLED BACK. See the file header. The proposal stays `executing` and
    // T13's reconcile lists it; the partial answers stay, because they are true.
    throw err;
  }

  // 5. The outcome.
  const outcome = resolveDisposition(result.transport, result.conversation);
  await deps.spine.finishExecution(deps.approvalDb, proposalId, { ok: true });
  const recorded = await recordTouch(
    deps.crmDb,
    touchId,
    {
      disposition: outcome.disposition,
      // The nameless flag is the CALL's, already written; carry it so the update does not
      // silently clear it.
      identityUnverified: outcome.identityUnverified || payload.display_name === null,
      messageLeft: result.messageLeft ?? false,
      reachedOrdinal: await currentReached(deps.crmDb, touchId),
    },
    deps.intervals,
    now,
  );

  return {
    proposalId,
    touchId,
    disposition: recorded.disposition,
    identityUnverified: outcome.identityUnverified || payload.display_name === null,
    advancedClock: recorded.advancedClock,
  };
}

async function currentReached(db: pg.Pool, touchId: string): Promise<number | null> {
  const r = await db.query<{ reached_ordinal: number | null }>(
    `select reached_ordinal from crm.touches where id = $1`,
    [touchId],
  );
  return r.rows[0]?.reached_ordinal ?? null;
}
