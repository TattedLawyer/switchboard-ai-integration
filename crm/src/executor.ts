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
import { checkSendable } from "./email-guard.js";
import { checkCallable } from "./call-guard.js";

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

// ═══ THE KNOWLEDGE SEAM (C6 reaching the call path) ═════════════════════════════════════
// Declared HERE, like `Recheck`, because the executor states its own contracts and
// `crm/src/kb/lookup.ts` (the implementation) imports the types — never the reverse.

/**
 * One retrieved passage, carrying enough for the agent to be HONEST about it:
 *   · `text` — verbatim from her saved entry; the agent quotes, never invents.
 *   · `updatedAt` — when SHE last saved the underlying entry. Staleness is commercial
 *     harm (an agent quoting a sold property), so the timestamp rides with every passage
 *     and the agent can hedge ("as of early August…") or decline.
 *   · `title`/`kind` — so the agent can NAME its source instead of asserting from nowhere.
 *   · `entryId` — provenance for audit; chunk internals (ids, ordinals) stay below the seam.
 *   · `distance` — cosine distance of the match, so the adapter can refuse a far match
 *     instead of quoting the least-irrelevant thing in the store.
 */
export interface KnowledgePassage {
  text: string;
  title: string;
  kind: string;
  entryId: string;
  updatedAt: Date;
  distance: number;
}

/** The DEPS seam — pure retrieval, tenant-bound at construction (composition root), so
 *  neither the executor nor any adapter can name a tenant. Optional exactly like
 *  `recheckLiveDetails`: absent ⇒ the agent has no knowledge base. */
export type LookupKnowledge = (q: {
  text: string;
  topK?: number;
}) => Promise<KnowledgePassage[]>;

/**
 * 🚨 THE PER-CALL LOOKUP CAP. A caller who keeps asking gets an honest handoff ("I'll
 * have Marisol get back to you"), not an unbounded Q&A session on her phone bill. It is
 * enforced in `executeCall` — NOT in the kb factory — because it is CALL-LIFECYCLE state:
 * the factory's function is built once per process and shared across calls, so a counter
 * there would leak across calls; and the policy must hold for ANY future lookup
 * implementation, which makes it the executor's rule about calls, not the store's rule
 * about search.
 */
export const KNOWLEDGE_LOOKUP_CAP = 3;

/**
 * What the ADAPTER sees per lookup. A discriminated union, because the three
 * non-answers are different sentences in the agent's mouth:
 *   · ok + []        — searched, nothing relevant: "I don't have that information."
 *   · capped         — over the per-call budget: hand off, stop offering to check.
 *   · failed         — the lookup broke: "I can't check that right now." The call
 *     SURVIVES (a broken knowledge base must degrade a live conversation, never kill
 *     it), and the failure is logged loudly by the executor.
 * `remaining` tells the adapter how many lookups are left, so it can stop offering
 * before it hits the wall.
 */
export type KnowledgeLookupOutcome =
  | { ok: true; passages: KnowledgePassage[]; remaining: number }
  | { ok: false; reason: "capped" | "failed"; remaining: number };

export interface CallContext {
  touchId: string;
  payload: PlaceCallPayload;
  /** The questions THIS call was approved to ask, in order. */
  prompts: Array<{ id: string; questionKey: string; promptText: string }>;
  /** Commit one answer, now, mid-call. */
  answer: (questionId: string, value: string) => Promise<void>;
  /** How far down the list we have got. */
  reached: (ordinal: number) => Promise<void>;
  /** Ask the broker's knowledge base, mid-call — capped, fail-soft, tenant-scoped below
   *  the seam. ABSENT when the deps carry no `lookupKnowledge`: the adapter can only
   *  consume what the executor built; it can never construct a lookup itself. */
  lookupKnowledge?: (q: { text: string; topK?: number }) => Promise<KnowledgeLookupOutcome>;
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
  /** 🚨 The numbers this deployment may dial — the call twin of `EmailExecutorDeps.
   *  allowlist`, and the same doctrine: INJECTED, never read from `process.env` inside
   *  this function, so no test and no future caller can accidentally widen it. Empty
   *  means refuse every call (fail-closed). Checked BEFORE `beginExecution`, so a
   *  refusal burns no execution row; `livekitPlaceCall` re-checks it immediately before
   *  the dial, so a caller that bypasses this executor still cannot dial an unlisted
   *  number. */
  phoneAllowlist: readonly string[];
  /** Piece C's seam, MIRRORED here for the call path — declared so the two executors
   *  state the same contract, but `executeCall` does NOT invoke it yet: the call
   *  recipient is a phone number, not `payload.to`, so wiring it is NOT trivially
   *  symmetric and is deliberately out of Piece C's scope. Absent == "send". */
  recheckLiveDetails?: (payload: PlaceCallPayload) => Promise<Recheck>;
  /** The knowledge seam (C6 on the call path), OPTIONAL exactly like the recheck above:
   *  absent ⇒ the agent has no knowledge base and the call proceeds unchanged. Injected
   *  from the composition root (`crm/src/kb/lookup.ts`'s factory, embedder constructed
   *  ONCE at startup); `executeCall` wraps it with the per-call cap and the fail-soft
   *  boundary before the adapter ever sees it. */
  lookupKnowledge?: LookupKnowledge;
  now?: () => Date;
}

export interface ExecutedCall {
  proposalId: string;
  touchId: string;
  disposition: string;
  identityUnverified: boolean;
  advancedClock: boolean;
}

/** One row of the executor daemon's per-tick selection. */
export interface ApprovedActionRow {
  id: string;
  action_type: "send_email" | "place_call";
}

/**
 * The executor daemon's per-tick selection: every approved, UNEXPIRED card of a type this
 * process knows how to execute, oldest first. The daemon dispatches on `action_type` and
 * nothing else.
 *
 * Defined HERE, not in `scripts/executor-loop.ts`, because the loop sits outside every
 * tsconfig (its header says so, and a real bug shipped there because no typecheck ever saw
 * it) — the query and its row type live where the compiler and the pins can both see them,
 * and the loop only runs it and branches on the string.
 *
 * 🚨 `expires_at > now()` IS NOT DECORATION. Without it an approved-but-expired row is
 * selected every tick forever, and `beginExecution`'s compare-and-set refuses it every
 * time — a permanent poison that only ever reaches a log. The queue read filters expiry
 * the same way and for the same reason (queue.ts), independently of the sweeper, because
 * a sweeper alone fails open during exactly the outage that matters.
 */
export async function selectApprovedActions(
  db: pg.Pool,
  tenantId: string,
): Promise<ApprovedActionRow[]> {
  const r = await db.query<ApprovedActionRow>(
    `select id, action_type from approval.proposals
      where tenant_id = $1 and state = 'approved'
        and action_type in ('send_email', 'place_call')
        and expires_at > now()
      order by created_at, id`,
    [tenantId],
  );
  return r.rows;
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

  // 0. THE PHONE ALLOWLIST — the call twin of `executeEmail`'s step 4 (`checkSendable`),
  //    and in the same position for the same reason: BEFORE the gate and BEFORE
  //    `beginExecution`, so a refusal burns no execution row, records no touch, and
  //    leaves the proposal `approved`. 🚨 FAIL-CLOSED: an empty injected list refuses
  //    every call. Exact match on the approved E.164 bytes; `call-guard.ts` owns the
  //    doctrine (no prefixes, no wildcards, nothing read from the environment here).
  const callable = checkCallable(payload.phone_e164, deps.phoneAllowlist);
  if (!callable.ok) {
    throw new CallRefused(
      `proposal ${proposalId} must not be dialled: ${callable.reason}`,
    );
  }

  // 1. THE GATE, before anything moves. Approval on Tuesday does not make a Thursday call
  //    permitted, and a refusal here must not consume the one start the proposal gets.
  const gate = gateExecution({
    channel: "call",
    approvedAt: p.rows[0].created_at,
    now,
    window: deps.window,
  });
  if (!gate.allowed) throw new CallRefused(gate.reason ?? "refused by the outreach window");

  // 1b. ── STEP C INSERTION POINT — the call-side live-details recheck goes HERE, and is
  //     DELIBERATELY NOT IMPLEMENTED YET (awaiting the owner's ruling on its semantics).
  //     This is the same slot `executeEmail` runs `recheckLiveDetails` in — after every
  //     refusal-shaped guard, before `beginExecution` — so a "wait" burns nothing (zero
  //     `approval.executions` rows) and a "block" can take the claim and terminally fail
  //     it. `ExecutorDeps.recheckLiveDetails` above already declares the seam; the call
  //     recipient is a phone number rather than `payload.to`, so the verdict surface is
  //     NOT trivially symmetric and nothing here pretends it is.

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

  // 3b. THE KNOWLEDGE SEAM, wrapped for THIS call. The wrapper — not the kb factory —
  //     owns the per-call cap (call-lifecycle state; see KNOWLEDGE_LOOKUP_CAP's header),
  //     so the adapter can consume lookups but can never construct or un-cap them.
  const lookupDep = deps.lookupKnowledge;
  let lookupsUsed = 0;
  const lookupKnowledge =
    lookupDep === undefined
      ? undefined
      : async (q: { text: string; topK?: number }): Promise<KnowledgeLookupOutcome> => {
          // The cap refusal costs nothing and consumes nothing: the store is never
          // reached, and the adapter is TOLD, so it can hand off instead of re-asking.
          if (lookupsUsed >= KNOWLEDGE_LOOKUP_CAP) {
            return { ok: false, reason: "capped", remaining: 0 };
          }
          lookupsUsed += 1;
          try {
            const passages = await lookupDep(q);
            return { ok: true, passages, remaining: KNOWLEDGE_LOOKUP_CAP - lookupsUsed };
          } catch (err) {
            // 🚨 FAIL-SOFT, DELIBERATELY (K7). A live human is on the line: a broken
            // knowledge base degrades the ANSWER ("I can't check that right now" — the
            // adapter sees `failed`), never the CALL — an unhandled throw here would drop
            // the conversation, discard the intake in progress, and wedge the proposal
            // `executing`. The failed attempt still counts against the cap: the cap
            // bounds work ATTEMPTED, and a broken store must not be hammered mid-call.
            // Visible to the operator here, loudly, naming the touch.
            console.error(
              `[executor] knowledge lookup failed mid-call (touch=${touchId}) — the call ` +
                `continues without it: ${err instanceof Error ? err.message : String(err)}`,
            );
            return {
              ok: false,
              reason: "failed",
              remaining: KNOWLEDGE_LOOKUP_CAP - lookupsUsed,
            };
          }
        };

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
      ...(lookupKnowledge === undefined ? {} : { lookupKnowledge }),
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

// ═══════════════════════════════════════════════════════════════════════════════════════
// THE EMAIL EXECUTOR — a SIBLING of `executeCall`, not a branch inside it.
//
// 🚨 `executeCall` IS NOT EDITED, AND THERE IS NO DISPATCHER. Of `executeCall`'s ~120 lines,
// question-set resolution, `bound`, the `answer`/`reached` callbacks, `reachedOrdinal` and
// `identity_unverified` are all call-only. What the two share is ORDERING DISCIPLINE, not
// code. A dispatcher over two nearly-disjoint bodies is a second spine bought for nothing.
//
// THE ORDER, and why each step is where it is:
//   1. read the proposal            — no row            -> EmailRefused
//   2. action_type must be send_email                   -> EmailRefused
//   3. parsePayload (the .email() grammar)              -> EmailRefused
//   4. checkSendable (placeholders, CR/LF, allowlist)   -> EmailRefused
//   5. NO GATE CALL — `gates.ts:62` returns {allowed:true} for email unconditionally, so
//      calling it would be ceremony that reads like a check.
//  5b. recheckLiveDetails (Piece C, optional) — the send-time recheck against her LIVE
//      sheet. "send" proceeds; "wait" refuses HERE, before the claim; "block" claims and
//      immediately fails. Absent seam == unconditional "send".
//   6. beginExecution — the at-most-once claim AND the expiry compare-and-set
//   7. beginTouch — email touch, transcript_delivery NULL
//   8. sendEmail — the side effect (the transport re-checks the allowlist here too)
//   9. finishExecution({ok:true, vendorReference: messageId})
//  10. recordTouch('sent') — advances the LONG interval AND closes the follow-up, atomically
//
// 🚨 STEPS 1–4 ARE ALL BEFORE STEP 6, AND THAT IS THE LOAD-BEARING PROPERTY. A refusal must
// not burn the proposal's one permitted start, so every refusal leaves ZERO
// `approval.executions` rows. (Even the expiry refusal, which fires INSIDE `beginExecution`,
// leaves none: it inserts `started` and then rolls back on the failed CAS.)
//
// 🚨 STEP 7 BEFORE STEP 8, mirroring the call path: a touch that exists before the side
// effect can be reconciled after a crash; one created after cannot. The consequence is
// disclosed in KNOWN-ISSUES — a crash between 7 and 9 leaves the proposal `executing`, and
// `executing` is NOT in `closeTerminatedFollowUps`' terminal list, so the follow-up stays
// open and the date-aware guard silences that contact. This spike does not fix that; it is
// the first executor that can crash mid-send, which is what makes it newly reachable.
//
// 🚨 NO TIMER, NO RETRY, NO CLOCK COMPARISON. `now` is present for parity with the call
// path and is used ONLY as the timestamp handed to `recordTouch`. It decides nothing.

export class EmailRefused extends Error {}

export interface FollowUpEmailPayload {
  contact_id: string;
  to: string;
  subject: string;
  body: string;
}

/** The vendor seam, structurally identical to `crm/src/email-transport.ts`'s `SendEmail`.
 *  Restated here so `executor.ts` states its own contract; faked in tests.
 *
 *  `proposalId` is the correlation handle for the bounce reconciler: the transport carries
 *  it to the relay as message metadata, and a later ASYNCHRONOUS refusal is matched back to
 *  this proposal's touch through it (`bounces.ts`). The executor passes an id; the
 *  vendor-specific header spelling stays in the transport. */
export type SendEmailFn = (msg: {
  to: string;
  subject: string;
  body: string;
  proposalId?: string;
}) => Promise<{ messageId: string; accepted: string[]; rejected: string[]; response: string }>;

/** Mirrors `ApprovalSpine`, differing only in `parsePayload`'s return type. The
 *  `crm/src` -> `approval/src` import ban is preserved: the composition root wires the real
 *  functions in. */
export interface EmailApprovalSpine {
  beginExecution: (db: pg.Pool, proposalId: string) => Promise<unknown>;
  finishExecution: (
    db: pg.Pool,
    proposalId: string,
    outcome: { ok: boolean; vendorReference?: string; error?: string },
  ) => Promise<void>;
  parsePayload: (
    input: unknown,
  ) => { ok: true; value: FollowUpEmailPayload } | { ok: false; problem: string };
}

/** The send-time recheck's verdict (Piece C — `send-recheck.ts` is the implementation;
 *  the executor only obeys the verdict). */
export type Recheck =
  | { verdict: "send" }
  | { verdict: "wait"; reason: string }
  | { verdict: "block"; reason: string };

export interface EmailExecutorDeps {
  /** `switchboard_approval` — the spine's DB. */
  approvalDb: pg.Pool;
  /** `switchboard_crm` — the CRM side. */
  crmDb: pg.Pool;
  sendEmail: SendEmailFn;
  spine: EmailApprovalSpine;
  /** 🚨 INJECTED, never read from `process.env` inside this function. */
  allowlist: readonly string[];
  intervals: IntervalSettings;
  /** Piece C — the send-time recheck against her LIVE sheet, between `checkSendable` and
   *  `beginExecution`. OPTIONAL: absent means unconditional "send" — every existing
   *  caller compiles and behaves unchanged. Injected (`send-recheck.ts` via the
   *  composition root), never imported here. */
  recheckLiveDetails?: (payload: FollowUpEmailPayload) => Promise<Recheck>;
  /** Present for parity with the call path. Used ONLY as `recordTouch`'s timestamp; it
   *  decides nothing, and the no-timer pin exists to keep it that way. */
  now?: () => Date;
}

export interface ExecutedEmail {
  proposalId: string;
  touchId: string;
  /** Always `'sent'` on success — SUBMISSION ACCEPTED, never "delivered". */
  disposition: string;
  messageId: string;
  advancedClock: boolean;
}

export async function executeEmail(
  deps: EmailExecutorDeps,
  proposalId: string,
): Promise<ExecutedEmail> {
  const now = deps.now?.() ?? new Date();

  // 1.
  const p = await deps.approvalDb.query<{ payload: unknown; action_type: string }>(
    `select payload, action_type from approval.proposals where id = $1`,
    [proposalId],
  );
  if (p.rowCount !== 1) throw new EmailRefused(`no such proposal: ${proposalId}`);

  // 2.
  if (p.rows[0].action_type !== "send_email") {
    throw new EmailRefused(
      `proposal ${proposalId} is a ${p.rows[0].action_type}, not an email`,
    );
  }

  // 3.
  const parsed = deps.spine.parsePayload(p.rows[0].payload);
  if (!parsed.ok) {
    throw new EmailRefused(
      `proposal ${proposalId} carries a payload that would not produce an email: ${parsed.problem}`,
    );
  }
  const payload = parsed.value;

  // 4. The last refusal before anything is claimed or connected.
  const sendable = checkSendable({ ...payload }, deps.allowlist);
  if (!sendable.ok) {
    throw new EmailRefused(`proposal ${proposalId} is not fit to send: ${sendable.reason}`);
  }

  // 5. No gate. `gateExecution` returns {allowed:true} for email unconditionally.

  // 5b. THE SEND-TIME RECHECK (Piece C). A card approved on Monday can be sent on Tuesday
  //     to an address she has since corrected in her sheet; the proposer read live at
  //     PROPOSAL time, and this is the only reader at SEND time. The seam is optional:
  //     absent means unconditional "send", so every caller without it behaves as before.
  //
  // 🚨 "WAIT" IS BEFORE THE CLAIM, "BLOCK" IS AFTER IT — the asymmetry is the point.
  //     · "wait" is a TRANSIENT doubt (breaker halted, sheet unreachable, transport
  //       unconfigured, row not found yet): refusing HERE — before `beginExecution` —
  //       preserves the load-bearing property above: ZERO `approval.executions` rows, the
  //       proposal stays `approved`, and the next tick retries for free.
  //     · "block" is a TERMINAL verdict (the recipient she approved is no longer the
  //       recipient her sheet names): the claim is taken and IMMEDIATELY failed, because
  //       `execution_failed` is only reachable through `finishExecution`, which demands a
  //       `started` row — and `execution_failed` is terminal, so the proposal cannot be
  //       retried into the wrong inbox and `closeTerminatedFollowUps` can clean up.
  //       NO touch row: `beginTouch` is step 7 and must not run — nothing was attempted
  //       against the contact, so nothing may claim to have touched them.
  if (deps.recheckLiveDetails !== undefined) {
    const recheck = await deps.recheckLiveDetails(payload);
    if (recheck.verdict === "wait") {
      throw new EmailRefused(
        `proposal ${proposalId} is not sendable right now: ${recheck.reason}`,
      );
    }
    if (recheck.verdict === "block") {
      await deps.spine.beginExecution(deps.approvalDb, proposalId);
      await deps.spine.finishExecution(deps.approvalDb, proposalId, {
        ok: false,
        error: recheck.reason,
      });
      throw new EmailRefused(`proposal ${proposalId} must not be sent: ${recheck.reason}`);
    }
  }

  // 6.
  await deps.spine.beginExecution(deps.approvalDb, proposalId);

  // 7.
  const touchId = await beginTouch(deps.crmDb, {
    contactId: payload.contact_id,
    channel: "email",
    proposalId,
    phoneNumberId: null,
    questionSetId: null,
  });

  // 8. `proposalId` rides along as message metadata so that when the relay accepts now and
  //    refuses later, the bounce reconciler can find its way back to this touch. It is the
  //    ONLY per-message addition; the payload bytes themselves are untouched.
  let submission: Awaited<ReturnType<SendEmailFn>>;
  try {
    submission = await deps.sendEmail({
      to: payload.to,
      subject: payload.subject,
      body: payload.body,
      proposalId,
    });
  } catch (err) {
    // 🚨 TERMINAL. NO RETRY. The proposal moves to `execution_failed`, and the touch stays
    // with a NULL disposition — it does NOT claim `'sent'`, because nothing was sent.
    //
    // The follow-up row is still OPEN at this point (`recordTouch` never ran), which from
    // the next Manila midnight silences this contact via the date-aware guard. It is
    // recoverable: `closeTerminatedFollowUps` counts `execution_failed` as terminal. That
    // is why RUNBOOK makes `crm reconcile` MANDATORY after any failed send, not optional.
    await deps.spine.finishExecution(deps.approvalDb, proposalId, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // 9. `'sent'` means the relay accepted the submission. It does NOT mean delivered.
  await deps.spine.finishExecution(deps.approvalDb, proposalId, {
    ok: true,
    vendorReference: submission.messageId,
  });

  // 10.
  const recorded = await recordTouch(
    deps.crmDb,
    touchId,
    { disposition: "sent" },
    deps.intervals,
    now,
  );

  return {
    proposalId,
    touchId,
    disposition: recorded.disposition,
    messageId: submission.messageId,
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
