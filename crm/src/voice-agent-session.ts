// The scripted intake the agent worker runs — ALL of the worker's decidable logic, in one
// typechecked, pinned module. The worker's entry (`voice-agent/worker.ts`) sits outside
// every tsconfig — the same standing as `scripts/executor-loop.ts`, whose header records
// the snake_case bug that shipped precisely because no compiler ever saw it — so the entry
// is kept to PLUMBING (join room, build session, wire these deps) and everything a test
// can pin lives here.
//
// THE SHAPE OF A CALL (voice-agent-session.test.ts V1–V7):
//   AMD verdict -> machine: report + hang up, no questionnaire into a voicemail box.
//                -> human / machine-ivr / uncertain: the script runs. `uncertain` runs it
//                   because a human MAY be there — but it is REPORTED as `unknown`,
//                   verbatim: disposition.ts resolves 200+unknown to `unknown_answer`, and
//                   that is its call, never this worker's (the pinned laundering trap).
//   The script: the approved opening line VERBATIM, then each approved question in order,
//   ONE AT A TIME, each utterance awaited to completion before the next begins.
//
// UPSTREAM BUGS THIS MODULE'S SHAPE DEFENDS AGAINST (each guard names its bug; the
// plumbing-side guards live in voice-agent/worker.ts):
//   · agents-js #2157 (teardown race SKIPS shutdown callbacks): every answer is persisted
//     THE MOMENT it is final, mid-call, via `deps.persistAnswer` — never in any
//     shutdown/teardown hook. A death one turn later loses nothing already said.
//   · agents-js #2108 (post-barge-in loop leaves the agent silent) and the general dead-
//     line case: `nextFinalTranscript` carries a WATCHDOG — a silent turn ADVANCES the
//     script, and MAX_CONSECUTIVE_SILENCES consecutive silences end the call, so a silent
//     caller can never hang the job (and the leaked-job clock the transport runs against).
//   · agents-js #2059 (superseded speech handles repeat a sentence): one utterance at a
//     time, each awaited — this module never has two speeches in flight to supersede each
//     other. (Barge-in is ALLOWED, and not by choice alone: with a realtime model doing
//     server-side turn detection the library FORCES `allowInterruptions: true` on
//     `generateReply` — see the adapter section at the bottom of this file. The #2108
//     wedge is bounded by two watchdogs instead: the speak watchdog in the adapter and
//     the answer watchdog here.)
//
// IDENTITY IS NEVER CLAIMED. This scripted worker defines ZERO tools (the guard for
// agents-js #2249, where `toolChoice:'none'` can wedge Gemini Live's mic permanently), so
// the model has no channel to report an identity determination even when the opening line
// asked for one. The honest raw claim is therefore `identity_not_asked_*`: nobody RULED
// anybody in or out. disposition.ts maps that to answered/partial with
// `identity_unverified = true` — representable for named contacts too (016's CHECK bans
// only `wrong_person` + unverified) — so a completed intake still advances the loop while
// the touch says out loud that nobody verified who answered. A future adapter that CAN
// determine identity reports the `identity_confirmed_*` / `not_the_contact` outcomes; the
// bridge grammar already carries them.
//
// A consequence of the same zero-tools guard: the LIVE worker cannot run mid-call
// knowledge lookups (`ctx.lookupKnowledge` needs a tool call to reach). The knowledge seam
// stays fully exercised by `scriptedPlaceCall`; wiring it live is deferred until #2249 is
// fixed upstream — recorded in the deferred register, not discovered.
import {
  CALLEE_PARTICIPANT_IDENTITY,
  RINGING_TIMEOUT_S,
  mapAmdCategory,
  type AgentCallReport,
  type CallJobMetadata,
  type LiveKitAmdCategory,
} from "./call-bridge.js";

/** How long one question may hang in silence before the script advances. A declared
 *  duration on the vendor seam (the `email-transport.ts` precedent), compared against
 *  nothing in this repo — the SESSION's transcript wait consumes it. */
export const ANSWER_WATCHDOG_MS = 15_000;

/** Two questions in a row into silence means nobody is there. Stop asking a dead line. */
export const MAX_CONSECUTIVE_SILENCES = 2;

// ─── THE UNIFIED EXPIRY INVARIANT (2026-08-23 diagnosis; adversarial review 3b) ────────
// The answer-window expiry decision may only be taken after the in-flight model turn
// finalizes, bounded by (playout estimate + absolute cap); and a bound expiry must NOT
// count as caller silence if a turn was open.
//
// Why: on the live call the caller's answer committed 10.7s into the 15s window, but
// 3.1 withholds `turnComplete` until its playout estimate ends (probe E11) — so the
// committed answer was INVISIBLE to the loop, the window expired, silence was counted
// against a caller who had answered, and the loop's next-question directive interrupted
// the model's own 15.5s reply mid-playout (3/3 live interrupts, Δ47–51ms after expiry).
// `TurnAssembler.isTurnOpen()` was designed for the caller-side half of this (F4b) and
// consulted nowhere. The three constants below are the invariant's bounds; the two
// OPTIONAL seam methods on `ScriptedVoiceSession` are its eyes — a session without them
// (the V1–V11 fakes, the realtime adapter) takes the pre-fix behaviour verbatim.

/** The absolute cap on how far past its watchdog one answer window may be extended,
 *  totalled across every grant. Sized above the tracker's own 20s turn cap
 *  (voice-model-turn.ts) so a turn opening late in the window can still finalize
 *  inside the extension, while a server that never finalizes cannot hold a window
 *  open past ~45s (watchdog + cap). */
export const ANSWER_EXTENSION_CAP_MS = 30_000;

/** The caller-turn extension's AGE bound, measured from the open turn's START. Needed
 *  because `TurnAssembler.finalize` deliberately does not reset an interrupt-opened
 *  empty turn (the F4a carry, pinned in voice-direct-turns.test.ts) — one interrupt
 *  can hold `isTurnOpen()` true for the rest of the call, and an un-aged extension
 *  would then extend every remaining window for a silent caller. 10s is >3x the
 *  measured F4b batch latency (~3s from speech start to the end-of-utterance batch)
 *  and still bounds a stuck carry to one window's worth of patience. */
export const CALLER_TURN_EXTENSION_MAX_AGE_MS = 10_000;

/** Margin past the model turn's estimated finalize that the extension waits: the
 *  measured `turnComplete ≈ firstAudio + audioMs` held to ±4ms on a DRY socket (n=2)
 *  but is unvalidated on the live telephony leg, and an extension that ends 4ms before
 *  the finalize forfeits the answer it waited for. Erring early is SAFE (the expiry
 *  then declines to count silence and the answer still lands via the drain backfill);
 *  the margin just makes the capture path the common one. */
export const MODEL_TURN_FINALIZE_MARGIN_MS = 250;

/** How many times one question may be RE-asked after a delivery that did not put it in
 *  the caller's ear (`delivered: false` below), before the loop counts ONE silence and
 *  advances. Two re-asks + the original hand-off = three chances; more than that into a
 *  caller who keeps derailing the turn is the IVR-hostage experience the owner refuses
 *  to ship, and the silence accounting (MAX_CONSECUTIVE_SILENCES) still bounds the call
 *  behind it. */
export const MAX_QUESTION_REASKS = 2;

/**
 * What `say` actually accomplished — the 2026-08-22 leak call's fix (touch `0fcf2180-…`).
 * `say` used to resolve `void`, and the loop stamped `askedAt[i]` with the CLOCK READING
 * AT THE SAY CALL; but the model frequently does not voice the handed question then — it
 * finishes an interrupted sentence, acknowledges the caller, drains its own backlog —
 * and voices our question seconds later or NEVER. Every caller turn necessarily starts
 * after the say call, so every utterance bound to whatever question the loop thought was
 * open: the persisted rows had "how has your day been going?" answered with "Uh" and the
 * owner's own complaint stored as a lead's must-haves. `say` therefore now reports
 * DELIVERY, and the binding table is built from when the question actually reached the
 * caller's ear:
 *   · `delivered: true`  — audio left the room and playout completed uninterrupted.
 *     `voicedAt` is WHEN it began, from the LIBRARY's clock, not ours (see
 *     `realtimeScriptedSpeech`).
 *   · `delivered: false, partial: true` — audio left but the utterance was cut off
 *     mid-question. `voicedAt` still exists: the caller heard it begin, so a turn that
 *     starts after it MAY be answering it.
 *   · `delivered: false, partial: false` — no audio at all, but caller-speech evidence
 *     arrived in the grace window (the barge-in path): the question was never voiced,
 *     so NOTHING may ever bind to it until a re-ask actually lands.
 * The honest-death contract is UNCHANGED: no audio AND no caller evidence, a watchdog
 * expiry with no audio, or a stashed `exception()` still THROW out of `say`.
 */
export type SpeechDelivery =
  | { delivered: true; voicedAt: number }
  | { delivered: false; partial: true; voicedAt: number }
  | { delivered: false; partial: false };

/** One FINAL caller transcript plus WHEN the caller's turn began. `turnStartedAt` is
 *  epoch ms from `ChatMessage.createdAt`: the installed agent_activity.js (1.6.4,
 *  onUserInputTranscribed, ~1005–1014) builds the user message with
 *  `createdAt: turnStartedAt`, and the Google plugin hands over
 *  `turnStartedAt: targetGen._createdTimestamp` (realtime_api.js:935) — the moment the
 *  server took the turn, ALWAYS before any of its own audio reaches the room. Optional
 *  because upstream `turnStartedAt` is optional: a provider that omits it leaves
 *  `createdAt` defaulting to ARRIVAL time, which is a turn start only by coincidence —
 *  a seam with no real turn clock omits the field and takes the documented conservative
 *  fallback in `runIntakeCall`'s binding loop. */
export interface TimedTranscript {
  transcript: string;
  turnStartedAt?: number;
}

/** What this module needs from the live media session — implemented by the worker's
 *  plumbing over `AgentSession`, faked in tests. */
export interface ScriptedVoiceSession {
  /** Speak one utterance's SUBSTANCE and resolve when the attempt has SETTLED — awaited,
   *  one at a time, never preemptive (#2059). Resolves with what the attempt actually
   *  ACCOMPLISHED (`SpeechDelivery` above): "resolved" used to mean "asked", and the
   *  2026-08-22 leak call proved that lie corrupts data — the loop opened a question's
   *  answer window at the say CALL while the model voiced it seconds later or never, so
   *  callers' words were persisted under questions they had not heard. The live
   *  implementation is `realtimeScriptedSpeech` below: `generateReply` on the
   *  native-audio session (the model owns phrasing, this loop owns everything
   *  decidable), bounded by the speak watchdog, with the voiced-at time read from the
   *  LIBRARY's committed assistant item. Interruptible by the caller — barge-in is
   *  natural conversation, and the library forces it anyway on a server-turn-detection
   *  realtime model. Still THROWS on the honest-death paths: no audio and no caller
   *  evidence, watchdog expiry with no audio, or a stashed `exception()`. */
  say(text: string): Promise<SpeechDelivery>;
  /** The next FINAL user transcript, or null if none arrives within `timeoutMs` — the
   *  per-turn watchdog. `timeoutMs` of 0 is a pure QUEUE READ: return a turn that has
   *  already arrived or null, never wait — the intake loop drains with 0 after a
   *  failed delivery, where blocking a watchdog's worth on a question that is not in
   *  the caller's ear would stall the re-ask. (The worker's deadline loop gives this
   *  for free: remaining ≤ 0 returns null after one queue check.) The live worker
   *  queues `conversation_item_added` user items, which PRESERVE the turn-start time
   *  as `item.createdAt` — NOT `user_input_transcribed`, which drops `turnStartedAt`
   *  on the floor (events.d.ts: the transcribed event carries no turn time at all). A
   *  bare string is a transcript with NO usable turn time; it binds to the question
   *  currently being waited on (the conservative fallback — see the binding rule). */
  nextFinalTranscript(timeoutMs: number): Promise<TimedTranscript | string | null>;
  /** OPTIONAL — the unified expiry invariant's model-side eye: the absolute clock time
   *  (same clock as `deps.now`) by which any in-flight MODEL turn is expected to
   *  finalize — `ModelTurnTracker.sendWaitDeadline()` on the direct socket: the
   *  playout estimate (firstAudio + audioMs), absolutely capped. Undefined = no model
   *  turn in flight. A session without this method takes the pre-fix expiry behaviour
   *  verbatim. May legitimately read in the past (server running late) — the loop
   *  treats it as a wait bound, never a promise. */
  modelTurnDeadline?(): number | undefined;
  /** OPTIONAL — the caller-side eye: WHEN the currently-open caller turn began
   *  (`TurnAssembler.openTurnStartedAt()`), undefined when none is open. The loop
   *  age-bounds everything it derives from this, because an F4a interrupt carry can
   *  hold the surface open for the rest of the call (see
   *  CALLER_TURN_EXTENSION_MAX_AGE_MS). */
  callerTurnStartedAt?(): number | undefined;
  /** OPTIONAL — the energy eye (Fix A, 2026-08-24, the fix-25 hangup): a MONOTONIC
   *  count of caller-evidence windows from `CallerEnergyEvidence.evidenceWindows()`
   *  — windows of sustained CLEAR speech-level energy on the inbound leg (rms >= the
   *  evidence bar, not during our own playout, consecutive — the rule lives in
   *  voice-caller-energy.ts). The loop SNAPSHOTS this at answer-window open and
   *  re-reads it at the expiry decision: movement means the caller audibly spoke
   *  inside THIS window even though no transcript ever arrived (on the live call
   *  Gemini returned zero transcript-in while the meter measured the owner at rms
   *  0.0511–0.0905), so the expiry must not be counted as caller silence. SECONDARY
   *  evidence only: it never fabricates an answer, never advances the script's
   *  bindings, and a session without this eye takes the pre-fix behaviour verbatim. */
  callerEnergyEvidenceWindows?(): number;
}

export interface IntakeDeps {
  session: ScriptedVoiceSession;
  /** Persist ONE answer NOW — `recordAnswer` into `crm.answers` in the real worker. The
   *  moment this resolves, that answer survives any death (#2157 guard). */
  persistAnswer(questionId: string, value: string): Promise<void>;
  /** Mirror of the executor's `ctx.reached`: how far down the approved list we got. */
  reached(ordinal: number): Promise<void>;
  /** Publish the raw report where the transport can read it (room metadata). MUST happen
   *  before `hangUp` — deleting the room first tears down the channel being polled. */
  publishReport(report: AgentCallReport): Promise<void>;
  /** The documented hangup: delete the room (drops the PSTN leg and the agent job). */
  hangUp(): Promise<void>;
  /** The clock the binding loop reads when it compares a transcript's turn-start to a
   *  question's asked-at. INJECTED so tests own time (this repo's date-boundary lesson:
   *  three failures, one root cause) — decidable logic never calls `Date.now()`
   *  directly. Defaults to `Date.now` for the worker, which is CORRECT there and not
   *  merely convenient: `ChatMessage.createdAt` is stamped by the plugin in the same
   *  process off the same wall clock, so the two sides of the comparison agree. */
  now?(): number;
  /** OPTIONAL instrumentation tap — the review's mandate: without it the live gate on
   *  this fix is "vibes". The loop reports answer-window lifecycle events
   *  (open/extended/expiry) with LEVELS, COUNTS AND TIMESTAMPS ONLY — caller content
   *  must never pass through here (a caller's words belong in crm.answers under the
   *  broker's grants, never in process stdout). The worker wires this to its log line;
   *  absent, the loop says nothing. */
  instrument?(event: string, detail: Record<string, unknown>): void;
}

/**
 * Run one approved intake call. Returns the report it published; THROWS on any mid-call
 * failure — never fabricates a report (the transport's rule 2, honoured end to end: no
 * report means the executor's proposal stays visibly `executing` for reconcile, and the
 * answers persisted before the death stand, because they are true).
 */
export async function runIntakeCall(
  job: CallJobMetadata,
  amdCategory: LiveKitAmdCategory,
  deps: IntakeDeps,
): Promise<AgentCallReport> {
  const amdResult = mapAmdCategory(amdCategory);

  if (amdResult === "machine") {
    // A voicemail box gets no questionnaire and (Wave 1) no message — reciting her
    // approved opening to a recording is not an intake. Raw signals only: 200 + machine
    // is exactly the voicemail trap disposition.ts exists to decide.
    const report: AgentCallReport = {
      v: 1,
      amdResult,
      conversation: null,
      answersPersisted: 0,
      reachedOrdinal: 0,
    };
    await deps.publishReport(report);
    await deps.hangUp();
    return report;
  }

  // Human, or possibly one (`unknown` runs the script — hanging up on a possible human is
  // worse than asking; the RAW amd verdict still rides the report unlaundered).
  //
  // 🚨 EVERYTHING BELOW RUNS UNDER A HANGUP GUARD (2026-08-22, learned from a live call).
  // A mid-call throw used to skip BOTH `publishReport` and `hangUp`, and the worker's
  // cleanup closes only its database pool — so nothing released the line. The owner sat
  // listening to silence until he gave up. The transport cannot rescue him: it polls for
  // a report for sixteen minutes and cannot distinguish a call in progress from a dead
  // worker still occupying the room.
  //
  // The honest-death contract is UNCHANGED and still enforced by the `catch` below: no
  // report is published, nothing is fabricated, the original error propagates, and the
  // proposal stays visibly `executing` for a human. The transport's own rule 2 always
  // had the right shape — "cleanup, THEN a typed throw" — and this is the missing half.
  try {
    return await runApprovedScript(job, amdResult, deps);
  } catch (err) {
    // Best-effort courtesy, never a mask: a hangup that fails must not replace the
    // failure worth debugging.
    await deps.hangUp().catch(() => {});
    throw err;
  }
}

/** The approved script itself. Split out only so the hangup guard above can wrap every
 *  path through it without re-indenting the loop that all the pins point at. */
async function runApprovedScript(
  job: CallJobMetadata,
  amdResult: AgentCallReport["amdResult"],
  deps: IntakeDeps,
): Promise<AgentCallReport> {
  // The opening's substance is hers verbatim (rule 4). Its delivery outcome is NOT
  // acted on: the opening is not a question — nothing may ever bind to it — and a
  // caller who barged in over it is demonstrably present, which the first question's
  // own delivery handling absorbs. Re-greeting a person who just interrupted the
  // greeting is the IVR feel the owner refuses to ship.
  await deps.session.say(job.openingLine);

  const now = deps.now ?? (() => Date.now());

  let answersPersisted = 0;
  let reachedOrdinal = 0;
  let consecutiveSilences = 0;
  let askedAll = false;

  // WHEN each question was VOICED — `SpeechDelivery.voicedAt`, the library's clock
  // reading as the question's audio BEGAN reaching the caller, NOT the clock at the say
  // call. The 2026-08-22 leak call (touch `0fcf2180-…`) is why the distinction is
  // load-bearing: the model frequently voices the handed question seconds after the
  // hand-off (or never), and every caller turn starts after the say CALL — stamped at
  // the call, "how has your day been going?" was persisted as answered with "Uh" and
  // the owner's complaint became a lead's must-haves. `undefined` = never voiced: such
  // an ordinal can receive NOTHING. Barge-in still binds forward: a caller who starts
  // answering while the question is being spoken began their turn AFTER voicedAt.
  // Together with `answered` this is the binding table for every caller turn.
  const askedAt: Array<number | undefined> = job.prompts.map(() => undefined);
  const answered: boolean[] = job.prompts.map(() => false);

  // Committed NOW, not at hang-up and never in a shutdown hook (#2157). `reached` stays
  // MONOTONIC: a straggler filed against an earlier question must not walk the
  // executor's progress marker backwards.
  const commit = async (index: number, transcript: string): Promise<void> => {
    await deps.persistAnswer(job.prompts[index]!.id, transcript);
    answered[index] = true;
    answersPersisted += 1;
    if (index + 1 > reachedOrdinal) {
      reachedOrdinal = index + 1;
      await deps.reached(reachedOrdinal);
    }
  };

  // THE BINDING RULE — one decision for every caller turn, shared by the answer window
  // and the not-delivered drain below. The Google plugin emits a final transcript only
  // after the model's reply finishes generating — "seconds after the user spoke"
  // (realtime_api.js:929–935, verbatim) — so the FIFO the seam delivers can hand this
  // turn a straggler that answers an EARLIER question; consumed blindly it was
  // persisted under the FOLLOWING question's id (the original silent corruption), and
  // bound against SAY-CALL times it still misfiled everything the model had not voiced
  // yet (the 2026-08-22 leak call). Every transcript is therefore bound by its
  // TURN-START time against the VOICED-at table:
  //   · no turn time               -> the open question IFF it has a voiced time. The
  //     conservative fallback: without a timestamp staleness cannot be proven, and
  //     dropping would kill every intake on a provider that omits `turnStartedAt` —
  //     this degrades to exactly the pre-fix arrival-order behaviour, never worse. But
  //     a NEVER-VOICED question takes nothing even here: there is no question in the
  //     caller's ear for this to be answering.
  //   · began at/after the voicing -> the open question (barge-in included: a caller
  //     answering over the question's own audio began after voicedAt).
  //   · began before the voicing   -> the question that was AUDIBLE when the turn
  //     began: the latest VOICED one at or before the turn start, filed there iff
  //     still unanswered, otherwise DROPPED. Never misfiled. A turn from before any
  //     voiced question (AMD-window speech, the reply to the opening line, filler
  //     spoken at the model's own chatter — the leak call's "Uh") binds to nothing.
  const bindTurn = async (
    timed: TimedTranscript,
    i: number,
  ): Promise<"answered" | "filed" | "dropped"> => {
    const voicedI = askedAt[i];
    if (timed.turnStartedAt === undefined) {
      if (voicedI === undefined || answered[i]) return "dropped";
      await commit(i, timed.transcript);
      return "answered";
    }
    if (voicedI !== undefined && timed.turnStartedAt >= voicedI && !answered[i]) {
      await commit(i, timed.transcript);
      return "answered";
    }
    let openThen = -1;
    for (let k = i - 1; k >= 0; k -= 1) {
      const voicedK = askedAt[k];
      if (voicedK !== undefined && voicedK <= timed.turnStartedAt) {
        openThen = k;
        break;
      }
    }
    if (openThen >= 0 && !answered[openThen]) {
      await commit(openThen, timed.transcript);
      return "filed";
    }
    return "dropped"; // pre-voicing speech, or an echo of a question already answered
  };

  for (const [i, prompt] of job.prompts.entries()) {
    let gotAnswer = false;
    let windowOpen = false;

    // THE ASK LOOP — the leak call's other half. `say` now reports DELIVERY, and only
    // a full delivery opens this question's answer window. A not-delivered attempt
    // (cancelled before its first frame, or cut off mid-question) is RE-ASKED, bounded
    // by MAX_QUESTION_REASKS; between attempts, any caller turn already queued is
    // drained through `bindTurn` against VOICED times — it may answer an earlier
    // question (the leak call's "My day's been going pretty good", which the old loop
    // filed under "what kind of property?"), answer a PARTIALLY voiced attempt of this
    // one, or drop. It can never bind to a never-voiced ordinal.
    for (let attempt = 0; ; attempt += 1) {
      const delivery = await deps.session.say(prompt.promptText); // one at a time, awaited
      if (delivery.delivered || delivery.partial) {
        // The EARLIEST voicing wins. A re-ask is the same question: a caller turn that
        // began after the first (possibly cut-off) voicing is answering it, and
        // stamping the later re-ask's time instead would shove that turn backwards
        // onto an earlier question — a fresh misfile in the fix itself.
        const prior = askedAt[i];
        if (prior === undefined || delivery.voicedAt < prior) askedAt[i] = delivery.voicedAt;
      }
      if (delivery.delivered) {
        windowOpen = true;
        break;
      }
      // Not in the caller's ear. Drain what already arrived (timeout 0: queued turns
      // only — the seam's watchdog contract makes 0 a pure queue read), then re-ask.
      for (;;) {
        const raw = await deps.session.nextFinalTranscript(0);
        if (raw === null) break;
        const timed: TimedTranscript = typeof raw === "string" ? { transcript: raw } : raw;
        if (timed.transcript.trim() === "") continue; // not an answer; keep draining
        const bound = await bindTurn(timed, i);
        if (bound !== "dropped") consecutiveSilences = 0; // someone is talking to us
        if (bound === "answered") {
          // The partial voicing was answered mid-drain — re-asking a question the
          // caller has already answered is the IVR-hostage loop. Later queue entries
          // belong to later windows.
          gotAnswer = true;
          break;
        }
      }
      if (gotAnswer) break;
      if (attempt >= MAX_QUESTION_REASKS) break; // exhausted: ONE silence, below
    }

    // THE ANSWER WINDOW — only over a question that is actually in the caller's ear.
    //
    // Expiry runs under THE UNIFIED INVARIANT (see the constants block): when the
    // budget runs out but a turn is demonstrably in flight — the MODEL's (its
    // finalize is what makes a committed caller answer visible at all on the direct
    // socket) or a recently-opened CALLER turn (F4b's late batch) — the window is
    // EXTENDED, bounded by the turn's own deadline (+margin) or the caller turn's age
    // bound, all totalled under ANSWER_EXTENSION_CAP_MS. A session without the seam's
    // optional eyes never extends: `extensionGrant` returns 0 and this loop is the
    // pre-fix loop verbatim.
    let openTurnAtExpiry = false;
    let energyHeardAtExpiry = false;
    if (windowOpen && !gotAnswer) {
      const waitStarted = now();
      // The energy eye's per-window snapshot (Fix A): evidence is judged INSIDE this
      // window only — movement of the monotonic counter between open and expiry. A
      // caller who spoke during an EARLIER window must not silence-proof this one
      // (E7's third-window pin), and a session without the eye reads 0 > 0 = false —
      // the pre-fix behaviour verbatim.
      const energyAtOpen = deps.session.callerEnergyEvidenceWindows?.() ?? 0;
      const energyHeard = (): boolean =>
        (deps.session.callerEnergyEvidenceWindows?.() ?? 0) > energyAtOpen;
      const openTurnEvidence = (t: number): boolean => {
        if (deps.session.modelTurnDeadline?.() !== undefined) return true;
        const cs = deps.session.callerTurnStartedAt?.();
        return cs !== undefined && t - cs <= CALLER_TURN_EXTENSION_MAX_AGE_MS;
      };
      const extensionGrant = (t: number, alreadyExtended: number): number => {
        const room = ANSWER_EXTENSION_CAP_MS - alreadyExtended;
        if (room <= 0) return 0;
        const md = deps.session.modelTurnDeadline?.();
        if (md !== undefined && md + MODEL_TURN_FINALIZE_MARGIN_MS > t) {
          return Math.min(md + MODEL_TURN_FINALIZE_MARGIN_MS - t, room);
        }
        const cs = deps.session.callerTurnStartedAt?.();
        if (cs !== undefined && cs + CALLER_TURN_EXTENSION_MAX_AGE_MS > t) {
          return Math.min(cs + CALLER_TURN_EXTENSION_MAX_AGE_MS - t, room);
        }
        return 0;
      };
      deps.instrument?.("answer-window-open", { ordinal: i + 1, at: waitStarted });
      let extended = 0;
      let budget = ANSWER_WATCHDOG_MS;
      while (budget > 0) {
        const raw = await deps.session.nextFinalTranscript(budget);
        if (raw === null) {
          // The watchdog's silence signal — now the EXPIRY DECISION POINT, which the
          // invariant forbids taking while a turn is in flight.
          const t = now();
          const grant = extensionGrant(t, extended);
          if (grant <= 0) {
            openTurnAtExpiry = openTurnEvidence(t);
            break;
          }
          extended += grant;
          budget = grant;
          deps.instrument?.("answer-window-extended", {
            ordinal: i + 1,
            at: t,
            grantMs: grant,
            extendedTotalMs: extended,
            modelTurnInFlight: deps.session.modelTurnDeadline?.() !== undefined,
            callerTurnOpen: deps.session.callerTurnStartedAt?.() !== undefined,
          });
          continue;
        }
        const timed: TimedTranscript = typeof raw === "string" ? { transcript: raw } : raw;
        if (timed.transcript.trim() === "") break; // whitespace is silence, not an answer
        const bound = await bindTurn(timed, i);
        if (bound === "answered") {
          gotAnswer = true;
          break;
        }
        if (bound === "filed") {
          consecutiveSilences = 0; // someone is demonstrably talking to us
        }
        // The deadline never resets — extensions extend it, nothing rewinds it.
        budget = ANSWER_WATCHDOG_MS + extended - (now() - waitStarted);
      }
      if (!gotAnswer) {
        // Fix A: the energy verdict is taken HERE, once, at the same decision point
        // that stamps the expiry line — the counter is monotonic, so this read sees
        // everything the window heard. NO extension path rides on energy (a design
        // choice, recorded): the caller's speech is already fully heard by the model
        // side; what energy proves is only that the silence VERDICT would be false.
        energyHeardAtExpiry = energyHeard();
        deps.instrument?.("answer-window-expiry", {
          ordinal: i + 1,
          at: now(),
          extendedTotalMs: extended,
          modelTurnInFlight: deps.session.modelTurnDeadline?.() !== undefined,
          callerTurnOpen: deps.session.callerTurnStartedAt?.() !== undefined,
          energyEvidence: energyHeardAtExpiry,
          countedSilence: !openTurnAtExpiry && !energyHeardAtExpiry,
        });
      }
    }
    if (gotAnswer) {
      consecutiveSilences = 0;
    } else if (openTurnAtExpiry || energyHeardAtExpiry) {
      // The invariant's second clause: a bound expiry with a turn still open is NOT
      // caller silence — the caller may be mid-answer behind a finalize that never
      // came (the live call counted two of these against a caller who answered both
      // times, one short of the dead-line hangup). Not RESET either: an open model
      // turn is not proof a person is there — the count simply does not move on
      // evidence this ambiguous, and the extension cap already bounded the wait.
      //
      // Fix A widens this clause to the energy eye: a window in which the meter
      // heard SUSTAINED CLEAR caller speech (fix-25: the owner talking at rms
      // 0.0511–0.0905 with zero transcript-in) is not caller silence either —
      // `countedSilence` is not set and MAX_CONSECUTIVE_SILENCES does not advance.
      // Same conservative posture: no RESET (energy is secondary evidence, not an
      // answer), and the honest-death property narrows exactly as reviewed (F4): a
      // broken call with no caller evidence of ANY kind still counts its silences,
      // publishes nothing, and wedges for reconcile.
    } else {
      // The watchdog, and the re-ask bound: a silent window OR an ordinal whose every
      // ask attempt failed to deliver counts as exactly ONE silence — the script
      // advances instead of hanging, and MAX_CONSECUTIVE_SILENCES still ends a call
      // where nothing lands twice in a row.
      consecutiveSilences += 1;
      if (consecutiveSilences >= MAX_CONSECUTIVE_SILENCES && i < job.prompts.length - 1) {
        break; // a dead line is not interrogated further
      }
    }
    if (i === job.prompts.length - 1) askedAll = true;
  }

  // The honest raw claim: complete only when EVERY approved question got an answer;
  // anything less is cut_off (-> `partial` downstream — disposition.ts's decision).
  // Never `identity_confirmed_*`: see the header — nobody determined anything.
  const conversation =
    askedAll && answersPersisted === job.prompts.length
      ? ("identity_not_asked_complete" as const)
      : ("identity_not_asked_cut_off" as const);

  const report: AgentCallReport = {
    v: 1,
    amdResult,
    conversation,
    answersPersisted,
    reachedOrdinal,
  };
  await deps.publishReport(report); // report FIRST…
  await deps.hangUp(); // …then the hangup, or the transport polls a deleted room
  return report;
}

// ═══ THE REALTIME ADAPTER — how the seam above rides a native-audio AgentSession ════════
//
// Two defects reproduced on a real call (2026-08-21) shaped everything below. Both fixes
// use PUBLIC, documented API of the installed @livekit/agents@1.6.4 — no underscore
// internals:
//
//   DEFECT 1 — the agent could not HEAR. The session was never bound to the SIP
//   participant: the callee's track logged `subscribed:false` once and never subscribed,
//   and AMD classified 20s of dead air (`uncertain / detection_timeout /
//   speechDurationMs:0`) while a human was talking. The supported binding is
//   `RoomInputOptions.participantIdentity` on `session.start()` ("The participant to
//   link to. If not provided, link to the first participant." — room_io.d.ts, public)
//   plus `AMDOptions.participantIdentity` ("Restrict AMD to a specific participant…
//   When unset, AMD binds to whichever participant the session is linked to." —
//   amd.d.ts, public). NOT `session._roomIO.setParticipant()`: `_roomIO` is tagged
//   `@internal` and may vanish in a patch release. The identity used is the SAME
//   constant the transport dials with (`CALLEE_PARTICIPANT_IDENTITY`, call-bridge.ts).
//
//   DEFECT 2 — the agent could not SPEAK. `session.say()` threw `trying to generate
//   speech from text without a TTS model`: this stack runs Gemini Live NATIVE AUDIO, and
//   `say` is a TTS path. The supported route on a realtime model is
//   `session.generateReply({ instructions })` (LiveKit's own docs: use generate_reply
//   with a realtime model), which the Google plugin delivers as a model-role turn +
//   turnComplete (realtime_api.cjs 465–527). The plugin gates it on
//   `!model.includes("3.1")` — the pinned `gemini-2.5-flash-native-audio-preview-12-2025`
//   is on the permissive side.
//
// BARGE-IN — a decided trade, not an accident. `allowInterruptions: false` is simply not
// available here: agent_activity.js warns "the RealtimeModel uses a server-side turn
// detection, allowInterruptions cannot be false when using VoiceAgent.generateReply()"
// and FORCES it true. The alternative — disabling Gemini's server-side activity
// detection and running local VAD turn detection — was rejected: it is a far larger
// behavioural change, and the owner's ruling is that the agent must NOT feel like an IVR
// that talks over people. So the caller may interrupt (natural conversation), and the
// #2108 failure mode (post-barge-in loop leaves the agent silent) is bounded honestly
// instead of prevented: the SPEAK watchdog below releases a wedged utterance, and the
// ANSWER watchdog above advances or ends the call. The agent can go quiet for at most
// one bounded window; it can never die silently mid-script.

/** What this adapter needs from the live `AgentSession`. STRUCTURAL on purpose: the crm
 *  workspace must never import `@livekit/agents` (the ONNX-stack dependency trade
 *  recorded in call-transport.ts) — the worker passes the real session, tests pass a
 *  fake, and the compiler checks the shape both ways. */
export interface RealtimeReplyHandle {
  /** Resolves when the generated speech has entirely played out
   *  (`SpeechHandle.waitForPlayout`, public). 🚨 RESOLVING PROVES NOTHING: the library's
   *  `_markDone(error)` stashes the error and resolves `doneFut` — it never rejects
   *  (speech_handle.js:299–305 in the installed 1.6.4) — so a silently-failed utterance
   *  and a spoken one look identical here. That is why the adapter also consults the
   *  speech observer, and `exception()` when present. */
  waitForPlayout(): Promise<void>;
  /** `SpeechHandle.exception()` (public, speech_handle.d.ts:134 — NOT `@internal`):
   *  the stashed error that completed the handle, if any. Optional and structural: only
   *  one library call site actually passes an error into `_markDone`, so this alone is
   *  NOT sufficient detection — but anything it does return is definitive. It THROWS on
   *  a not-yet-done handle (speech_handle.d.ts doc), so the adapter reads it only after
   *  playout resolved. */
  exception?(): unknown;
  /** `SpeechHandle.chatItems` (public getter, speech_handle.ts:243 in the installed
   *  1.6.4 src) — the items THIS speech committed to the chat context. On the realtime
   *  path the assistant `ChatMessage` is committed with playback-synchronized content,
   *  an `interrupted` flag when playout was cut short, and — the fact the leak-call fix
   *  is built on — `createdAt = startedSpeakingAt`, the wall-clock moment the FIRST real
   *  audio frame of this speech reached the room (agent_activity.ts:3716–3719 sets it in
   *  onFirstFrame; :3944–3968 builds the message and calls `_itemAdded`). A speech that
   *  never framed forwards no text and commits NO assistant item (`if (!forwardedText)
   *  continue;`, :3949). Optional and structural: the crm workspace never imports
   *  `@livekit/agents`; the worker passes the real handle, fakes may omit it. */
  chatItems?: ReadonlyArray<CommittedSpeechItem>;
}

/** The structural sliver of the library's `ChatItem` union this module reads. Every
 *  field optional: `FunctionCall` items carry no `role`, and only assistant MESSAGES
 *  speak for when our utterance was voiced. */
export interface CommittedSpeechItem {
  type?: string;
  role?: string;
  interrupted?: boolean;
  /** Epoch ms. On the realtime path this is `startedSpeakingAt` — see
   *  `RealtimeReplyHandle.chatItems`. */
  createdAt?: number;
}

/**
 * How the adapter learns whether an utterance's audio ACTUALLY LEFT — because
 * `waitForPlayout()` resolving cannot tell (see `RealtimeReplyHandle`). The worker
 * implements it over `agent_state_changed`: the session enters `'speaking'` from
 * onFirstFrame — the first REAL audio frame reaching the room
 * (agent_activity.js:2653–2656 on the realtime path) — the one signal a generation that
 * died before producing sound can never emit. Structural on purpose (the crm workspace
 * never imports `@livekit/agents`): the worker passes an event-fed flag, tests pass a
 * fake, the compiler checks both.
 */
export interface SpeechDeliveryObserver {
  /** Reset before this turn's `generateReply` — the flag must not inherit a previous
   *  utterance's audio. */
  arm(): void;
  /** Has any audio reached the room since `arm()`? */
  spoke(): boolean;
  /** OPTIONAL, and the discriminator that keeps a barge-in from killing a live call:
   *  has the CALLER been heard since `arm()`? A caller who speaks is demonstrably
   *  present — the opposite of the dead line the silent-utterance guard exists to catch.
   *  Absent on fakes and on any feed that cannot report it, in which case the guard
   *  behaves exactly as it did before (throws). */
  callerSpokeSinceArm?(): boolean;
  /** OPTIONAL: WHEN (epoch ms) the first audio frame since `arm()` was observed — the
   *  worker feeds it from the same `agent_state_changed -> 'speaking'` event that sets
   *  `spoke()` (the event's own `createdAt`, stamped at emit). This is the FALLBACK
   *  voiced-at only: the primary source is the committed assistant item's
   *  `createdAt = startedSpeakingAt` on the handle (see `RealtimeReplyHandle.chatItems`),
   *  which is the library's own first-frame clock rather than an observer of it. */
  firstFrameAt?(): number | undefined;
}

/** How long to wait for caller evidence after a turn produced no audio, before calling
 *  it a silent failure. NOT tunable comfort: on the 2026-08-22 live call the interrupt
 *  arrived 23ms before the throw and the transcript of the barged-in speech did not
 *  exist yet, so a SYNCHRONOUS check cannot see it. Short enough that a genuinely dead
 *  line still fails fast; long enough for one caller utterance to be reported. */
export const BARGE_IN_GRACE_MS = 1_500;

/** The default for callers with no audio-state feed (the V1–V6 unit fakes): trusts
 *  playout, so the silent-failure guarantee below simply does not engage. The WORKER
 *  always injects the real observer — that wiring is the plumbing half of this fix. */
const TRUST_PLAYOUT_OBSERVER: SpeechDeliveryObserver = {
  arm: () => {},
  spoke: () => true,
};

export interface RealtimeReplySession {
  /** `AgentSession.generateReply` (public). `instructions` drives THIS turn's content;
   *  the standing `INTAKE_INSTRUCTIONS` (given to the Agent at construction) governs the
   *  whole call, including any replies the server generates on its own between our
   *  scripted turns. */
  generateReply(options: { instructions: string }): RealtimeReplyHandle;
}

/**
 * The standing session instruction. LOOSENED BY OWNER DECISION (2026-08-21): the broker
 * approves her questions at the level of SUBSTANCE, not literal wording — the previous
 * "speak only the exact scripted utterances" produced exactly the fifteen-year-old-IVR
 * cadence the owner refuses to ship. The model owns PHRASING (SETTLED: no verbatim
 * enforcement, no TTS, no pre-rendered audio); the loop keeps everything decidable —
 * which question is open, the order, when to advance, what persists.
 *
 * REWRITTEN 2026-08-24 after a live call INVENTED questions the broker never approved
 * ("do you happen to know your credit score range?", "…selling your property at 123
 * Main Street?" — a fabricated address). Every invention arrived in an AUTO-REPLY: a
 * model turn triggered by caller speech that our loop never initiated. The old text's
 * single negative clause ("never invent questions…") was the ALREADY-FAILED control —
 * 3.1 invented under it in 4/4 dry-socket probes. This rewrite went 0/4 with the
 * owner-praised deferral preserved (probe-invent findings, E3/E5). What changed and
 * why, each piece pinned in V0c:
 *   · WHITELIST framing, positively phrased — the handed pieces are the ONLY question
 *     source; "do exactly X" outperforms "don't do Y".
 *   · The auto-reply moment is NAMED, with what IS allowed there (acknowledge /
 *     identify / defer-and-pass-along) — the inventions all lived in the unnamed gap.
 *   · 🔑 The surface-checkable rule: an acknowledgment never ends in a question mark —
 *     checkable mid-generation without the model classifying its own intent, and it is
 *     the probe's mechanical boundary (declarative = reciprocity, interrogative =
 *     invention).
 *   · The banned categories are named WITH the priors 3.1 reaches for (budgets,
 *     addresses, credit, financing — US telemarketing-script staples).
 *   · Anti-silence permission — much invention is the model solving a "dead air"
 *     problem nobody told it wasn't a problem.
 *   · Out-of-scope, AI disclosure, opt-out, length/format, repeat≠new — the owner's
 *     addendum.
 * Prevention here is PROBABILISTIC (native audio: no pre-synthesis gate exists, and
 * the Live API has no responseSchema/toolConfig to force structure) — the post-hoc net
 * is voice-invention.ts. NOTE: this instruction is SHARED by 2.5 (worker.ts) and 3.1
 * (worker-direct.ts); 2.5 invents nothing under either wording (0/5 observed), so
 * changes here must stay model-neutral.
 */
export const INTAKE_INSTRUCTIONS =
  "You are making a brief, friendly intake call on behalf of a real-estate broker. " +
  "The broker approved, in advance, the exact list of questions this call may ask. " +
  "You do not hold that list: each approved question is handed to you one piece at a " +
  "time as an explicit instruction, and the handed pieces are the only questions you " +
  "may ask on this call. A spoken turn of yours is the handed piece, delivered " +
  "naturally in your own words — warm, plain, concise — and nothing else: never " +
  "invent questions you were not handed, never change what a handed question is " +
  "asking, and never claim to have taken, scheduled, or promised any action. Ask one " +
  "thing at a time, then stop and listen. Speak in one or two plain sentences per " +
  "turn; never read out lists, headings, or formatting. " +
  "Often the caller will say something when you have not been handed a new piece. In " +
  "that moment you may do exactly three things: briefly acknowledge what they said, " +
  "say who you are, or defer a question and pass it along to the broker. An " +
  "acknowledgment is at most a short reflection of what the caller just said, and it " +
  "never ends in a question mark. Never ask a question of your own in those moments — " +
  "no follow-ups, no qualifying questions: never ask about budgets, addresses, " +
  "credit, or financing, and never ask anything else the broker did not hand you. " +
  "If nothing has been handed to you, saying nothing (or only a brief acknowledgment) " +
  "is correct — silence between pieces is normal on this call, you never need to fill " +
  "it or announce that you are waiting, and the next question always arrives as a " +
  "handed instruction; it is never yours to improvise. " +
  "If the caller asks about something you were not handed, say plainly that you don't " +
  "have that information and the broker will follow up — never guess, estimate, or " +
  "answer from general knowledge; you are just gathering information for the broker " +
  "and will pass it along. " +
  "You have no personal name — do not give yourself a personal name. If anyone asks " +
  "who or what you are, or whether you are a person or an AI, say directly that you " +
  "are an AI assistant calling on behalf of the broker. " +
  "If the caller asks not to be contacted, says stop, or wants off the list: " +
  "acknowledge it, confirm it will be passed on, and ask nothing further. " +
  "If you could not hear or understand an answer, asking the caller to repeat the " +
  "same thing is fine — a repeat is not a new question.";

/** The per-turn instruction: the approved utterance rides inside VERBATIM (so the pins
 *  can see the substance is intact), wrapped in the phrasing licence and its limits. */
export function speakTurnInstruction(utterance: string): string {
  return (
    "Say this to the caller now, in your own natural words, keeping exactly what it " +
    'says or asks — do not add new questions or claims: "' +
    utterance +
    '" Then stop speaking and listen.'
  );
}

/** How long one utterance may sit in generation/playout before the script moves on —
 *  the bound on a #2108-style wedge (generateReply that never reaches playout, e.g. the
 *  plugin's own 5s generation timeout dying inside the speech task). Generous: a spoken
 *  question plus a courteous acknowledgement fits well inside it. */
export const SPEAK_WATCHDOG_MS = 30_000;

/**
 * The live implementation of `ScriptedVoiceSession.say`: one approved utterance in, one
 * `generateReply` turn out, one DELIVERY OUTCOME back (the 2026-08-22 leak-call fix —
 * resolving void let the loop believe "handed over = voiced", and the persisted rows of
 * touch `0fcf2180-…` show what that filed). Per turn: arm the observer, generate, race
 * playout against the speak watchdog, then decide —
 *   · playout resolved AND audio left        -> `delivered: true` (or `partial: true`
 *     when the committed assistant item says the utterance was cut off), with
 *     `voicedAt` read from the LIBRARY: the assistant `ChatMessage`'s
 *     `createdAt = startedSpeakingAt` via the public `SpeechHandle.chatItems` — never
 *     this process's clock at the say call;
 *   · watchdog expired BUT audio left        -> same delivered outcome: the agent spoke
 *     and is merely slow (a long courteous turn must not kill the call); a truly dead
 *     call is still bounded by the answer watchdog and MAX_CONSECUTIVE_SILENCES;
 *   · `exception()` returned a stashed error -> THROW it (the one path that populates
 *     the stash);
 *   · NO audio left + caller evidence        -> `delivered: false, partial: false`: the
 *     barge-in path — the question was never voiced, and the loop must not open its
 *     answer window (returning void here is what let the old loop bind the barged-in
 *     speech to a question nobody heard);
 *   · NO audio left, no evidence             -> THROW, naming the utterance and which
 *     condition fired (the honest death, unchanged).
 *
 * WHY THE OBSERVER — the real mechanism, precisely: `SpeechHandle._markDone(error)`
 * stashes the error and RESOLVES `doneFut`; it never rejects (speech_handle.js:299–305,
 * installed 1.6.4). So `waitForPlayout()` resolves identically whether the agent spoke
 * or silently failed — e.g. the Google plugin's own 5s generateReply timeout, whose
 * rejection the library swallows in an empty catch. Upstream knows: livekit/agents
 * #6224; the fix-by-rejecting PR #6226 was REJECTED, so this never improves on its own.
 * An earlier version of this comment claimed "a playout FAILURE propagates" — false as
 * written (exactly what the cold review flagged): only the rare rejected-playout path
 * propagates by itself; `agent_state_changed -> 'speaking'` (emitted from onFirstFrame,
 * fed in by the worker as the observer) covers everything else. Without it, a failed
 * utterance was recorded as CALLER silence, and two of those published a normal-shaped
 * report — a fabricated outcome, violating `runIntakeCall`'s "THROWS on any mid-call
 * failure" promise (transport rule 2).
 */
export function realtimeScriptedSpeech(
  session: RealtimeReplySession,
  opts?: { observer?: SpeechDeliveryObserver; watchdogMs?: number; graceMs?: number },
): (utterance: string) => Promise<SpeechDelivery> {
  const observer = opts?.observer ?? TRUST_PLAYOUT_OBSERVER;
  const watchdogMs = opts?.watchdogMs ?? SPEAK_WATCHDOG_MS;
  const graceMs = opts?.graceMs ?? BARGE_IN_GRACE_MS;
  return async (utterance) => {
    // BEFORE generateReply: no window in which this turn's audio could land unobserved.
    observer.arm();
    const handle = session.generateReply({ instructions: speakTurnInstruction(utterance) });
    const playout = handle.waitForPlayout();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: "playout" | "watchdog";
    try {
      outcome = await Promise.race([
        playout.then(() => "playout" as const),
        new Promise<"watchdog">((resolve) => {
          timer = setTimeout(() => resolve("watchdog"), watchdogMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // A playout that fails AFTER the watchdog already released this turn must not
      // become an unhandled rejection — a rejection racing above still propagates.
      void playout.catch(() => {});
    }
    if (outcome === "playout" && handle.exception !== undefined) {
      // Read only after playout resolved: exception() throws on a not-done handle.
      const stashed = handle.exception();
      if (stashed !== undefined) {
        throw stashed instanceof Error
          ? stashed
          : new Error(`utterance ${JSON.stringify(utterance)} failed: ${String(stashed)}`);
      }
    }
    if (!observer.spoke()) {
      // 🚨 BEFORE CALLING THIS A DEATH: was the caller TALKING OVER US?
      //
      // 2026-08-22, on a live call with the owner: he interrupted, the scripted turn was
      // cancelled before its first audio frame, and this guard threw and hung up on him
      // mid-sentence. The obvious discriminator — `SpeechHandle.interrupted` — DOES NOT
      // WORK here, and research caught that before it shipped: the plugin emits
      // `input_speech_started` (what sets `interrupted`) only when no generateReply is
      // pending (`realtime_api.ts:1290-1296`, `:1730-1731`, both gated on
      // `!this.pendingGenerationFut`). The server's `interrupted:true` landed while our
      // future was still pending, so the handle completed UN-interrupted, unerrored, and
      // silent — byte-identical to a real death.
      //
      // The only evidence that separates them is the CALLER'S OWN VOICE, and it arrives
      // late: 23ms after the interrupt there was no transcript yet. Hence a grace window
      // rather than a synchronous check. A caller who speaks is present, which is the
      // exact opposite of the failure this guard exists to report.
      const callerEvidence = observer.callerSpokeSinceArm?.bind(observer);
      if (callerEvidence !== undefined) {
        // Barge-in: the caller is present and the question was NEVER voiced. Since the
        // leak-call fix this is REPORTED, not swallowed — a void return here is what
        // let the loop open an answer window on a question nobody heard, and bind the
        // barged-in speech to it.
        const bargedIn: SpeechDelivery = { delivered: false, partial: false };
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline) {
          if (callerEvidence()) return bargedIn; // the intake loop drains their turn
          await new Promise<void>((r) => setTimeout(r, 25));
        }
        if (callerEvidence()) return bargedIn;
      }
      throw new Error(
        outcome === "playout"
          ? `utterance ${JSON.stringify(utterance)} silently failed: playout resolved ` +
            `but no audio ever reached the room (SpeechHandle._markDone resolves ` +
            `instead of rejecting — livekit/agents #6224, fix rejected upstream)`
          : `utterance ${JSON.stringify(utterance)} silently failed: the speak ` +
            `watchdog (${watchdogMs}ms) expired and no audio ever reached the room`,
      );
    }
    // AUDIO LEFT. WHEN it began comes from the LIBRARY, not this process's clock at the
    // say call — the say-call stamp is the exact lie the leak call persisted. The
    // realtime path commits the assistant ChatMessage with
    // `createdAt = startedSpeakingAt` (the first real audio frame — verified in the
    // installed 1.6.4 src, agent_activity.ts:3716–3719 and :3956–3968) and an
    // `interrupted` flag when playout was cut short; a speech that never framed commits
    // no assistant item at all. Fallbacks, in honesty order: the observer's OWN
    // first-frame observation time (`firstFrameAt`, fed from the same event the library
    // emits at onFirstFrame) when no assistant item carries a time; and — reachable
    // only through fakes and the TRUST_PLAYOUT observer, never on the wired live path —
    // the clock at resolution, which is no worse than the pre-fix stamp.
    const assistantItems = (handle.chatItems ?? []).filter(
      (item) => (item.type === undefined || item.type === "message") && item.role === "assistant",
    );
    const voicedAt =
      assistantItems[0]?.createdAt ?? observer.firstFrameAt?.() ?? Date.now();
    const cutOff = assistantItems.some((item) => item.interrupted === true);
    return cutOff
      ? { delivered: false, partial: true, voicedAt }
      : { delivered: true, voicedAt };
  };
}

/**
 * Start the session BOUND to the callee — the fix for defect 1. `inputOptions.
 * participantIdentity` is RoomIO's public linking contract: RoomIO waits for exactly
 * this participant (the transport dials the SIP leg AFTER dispatching the agent, so the
 * wait is load-bearing), links it, and subscribes its audio — which is what puts the
 * caller's voice in front of both the model and AMD.
 */
export function startSessionBoundToCallee<A, R>(
  session: {
    start(options: {
      agent: A;
      room: R;
      inputOptions?: { participantIdentity?: string };
    }): Promise<void>;
  },
  agent: A,
  room: R,
): Promise<void> {
  return session.start({
    agent,
    room,
    inputOptions: { participantIdentity: CALLEE_PARTICIPANT_IDENTITY },
  });
}

// ═══ THE ANSWER GATE — AMD must not burn its detection budget on ringback ═══════════════
//
// The installed AMD (1.6.4, dist/voice/amd.js) arms `startDetectionTimer()` inside
// execute() (line 245) and RE-ARMS it at track-subscribe inside gateListening()
// (line 441) — both BEFORE its own `sip.callStatus === 'active'` wait; only
// `startListening()` (and with it the no-speech timer) is answer-gated — the class
// docstring admits exactly this split. With the transport's 60s ring budget, a callee
// answering after ~20s got `uncertain/detection_timeout` decided entirely on ringback,
// and the opening line was spoken into the ring. Upstream fixed exactly this in
// livekit/agents-js PR #2226 — merged 2026-08-20, AFTER 1.6.4 shipped — so this repo
// implements both halves itself:
//   (a) the worker starts AMD only after the call is ANSWERED — it awaits the callee's
//       `sip.callStatus === 'active'` attribute (the same vocabulary AMD's own gate
//       reads, pinned below) through `awaitCallAnswered`, which owns the never-answered
//       case; and
//   (b) `detectionTimeoutMs` is raised to cover the whole ring as a backstop, for a
//       gate that races or a carrier that feeds early media — safe because the
//       no-speech timer IS correctly answer-gated, so a raised budget cannot slow AMD
//       down on a genuinely answered call.

/** LiveKit's SIP participant-attribute vocabulary — the same strings AMD's own gate
 *  reads (amd.js `SIP_CALL_STATUS_ATTR` / its 'active' comparison). Pinned here so the
 *  worker stays wiring-only. */
export const SIP_CALL_STATUS_ATTRIBUTE = "sip.callStatus";
export const SIP_CALL_STATUS_ACTIVE = "active";

/** (a)'s bound: the transport's full ring plus the same 15s grace the transport gives
 *  its own dial round-trip (`DIAL_REQUEST_TIMEOUT_S`, call-transport.ts). If the
 *  attribute has not flipped by then, the dial side has already failed or given up. */
export const CALL_ANSWER_WAIT_MS = (RINGING_TIMEOUT_S + 15) * 1_000;

/** (b)'s backstop, and 🚨 DELIBERATELY SHORT — the opposite of what this constant held
 *  before, because a live call proved the old sizing was actively harmful.
 *
 *  WHY EVERY MILLISECOND HERE IS SILENCE ON THE LINE (2026-08-21, reproduced on a real
 *  call to a real handset, then traced end to end in the installed library):
 *  AMD's `execute()` calls `session.pauseReplyAuthorization()` (amd.ts:398), which sets
 *  `_authorizationPaused` (agent_activity.ts:924). The speech loop then POPS each queued
 *  utterance and PUSHES IT STRAIGHT BACK unprocessed while that flag is set
 *  (agent_activity.ts:2235), and the realtime generation task blocks on
 *  `speechHandle._waitForAuthorization()` BEFORE forwarding a single audio frame to the
 *  output (agent_activity.ts:3705-3712). So for the entire detection window the model
 *  generates — tokens burn, transcripts flow, `outputTranscription` looks perfect in the
 *  logs — and NOTHING reaches the callee. The agent is mute for exactly this long.
 *
 *  The old value (`ring + 20s` ≈ 80s) was written when AMD started at DIAL and had to
 *  survive the ring. `awaitCallAnswered` (a) now gates `execute()` on the ANSWER, so the
 *  ring is already excluded and the ring-sized budget bought nothing but up to a minute
 *  of dead air. Post-answer is the only window this needs to cover.
 *
 *  6s is chosen against the failure it guards: an `uncertain` verdict is SAFE here —
 *  `mapAmdCategory` sends it to "unknown", and `runIntakeCall` runs the script for
 *  unknown (hanging up on a possible human is worse than asking). A too-LONG budget has
 *  no such safety valve: it is silence a real person hears and hangs up on, which is
 *  precisely what happened. Erring short costs verdict confidence; erring long costs the
 *  call. */
export const AMD_DETECTION_TIMEOUT_MS = 6_000;

/**
 * Bound the worker's wait for `sip.callStatus === 'active'` so a never-answered call
 * can never hang the job. `wait` is the worker's plumbing over the library's public
 * `waitForParticipant` + `waitForParticipantAttribute` (dist/utils.d.ts:351; the
 * attribute wait THROWS if the participant is not in the room yet, hence participant
 * first); THIS function owns every decision — the bound, the abort, the outcome. On the
 * bound it ABORTS the vendor wait and THROWS: the call never happened for this worker,
 * so nothing is spoken, no AMD verdict is manufactured, and no report is published (the
 * honesty rules end to end — the transport's own dial has already failed at the 60s
 * ring bound and thrown `LiveKitCallFailed`, leaving the proposal visibly `executing`
 * for reconcile). Proceeding blind was REJECTED: on a truly dead call it would run the
 * whole script into silence and then publish a normal-shaped `cut_off` report — a
 * fabricated outcome in exactly the shape rule 2 forbids. A vendor failure inside the
 * wait (participant gone, room closed) propagates unchanged.
 */
export async function awaitCallAnswered(
  wait: (signal: AbortSignal) => Promise<unknown>,
  timeoutMs: number = CALL_ANSWER_WAIT_MS,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waiting = wait(controller.signal).then(() => "answered" as const);
  try {
    const outcome = await Promise.race([
      waiting,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    if (outcome === "timeout") {
      controller.abort();
      throw new Error(
        `the callee never answered: sip.callStatus did not reach 'active' within ` +
          `${timeoutMs}ms (ring budget ${RINGING_TIMEOUT_S}s + grace) — refusing to ` +
          `run AMD or the script against a call that never connected`,
      );
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // The aborted vendor wait rejects after we have already thrown — never unhandled.
    void waiting.catch(() => {});
  }
}

/** AMD options, all four pinned: never interrupt (the hangup is OURS — report first,
 *  then deleteRoom), restricted to the SAME participant the transport dials (so AMD's
 *  track gate and verdict can only ever be about the callee), a SHORT detection budget
 *  (`AMD_DETECTION_TIMEOUT_MS` above — every ms of it is enforced silence), and:
 *
 *  🚨 `waitUntilFinished: false` — THE SETTING THAT MAKES THE PHONE TALK. It defaults to
 *  TRUE (amd.ts:360) and we were letting it. At amd.ts:912 the settle path reads
 *  `if (!(this.waitUntilFinished && hasSpeech)) { this.eotReached = true; }` — so with
 *  the default ON and ANY speech heard, the detection budget STOPS CAPPING: the verdict
 *  is computed but its release stays gated on end-of-turn. On the 2026-08-21 live call
 *  the callee's carrier answered with a screening greeting ("if you record your name and
 *  reason for calling…"), which counts as speech, so AMD stopped being bounded by its
 *  own timeout and did not settle for FORTY-TWO SECONDS — releasing only when the human
 *  gave up and hung up (`amd prediction category:"human"` fired at the disconnect, and
 *  `resumeReplyAuthorization` then threw "AgentSession is not running" against the
 *  already-closed session). Every second of that was reply authorization held down, i.e.
 *  a person holding a silent phone. With it FALSE, `eotReached` is set the moment the
 *  budget expires and the verdict releases on a bounded schedule.
 *
 *  The property it gives up is real and accepted: `waitUntilFinished` exists so AMD does
 *  not cut a machine's greeting short and misjudge it. We take the weaker verdict — an
 *  early `uncertain` runs the script (safe: see AMD_DETECTION_TIMEOUT_MS) — because a
 *  confident verdict delivered to someone who already hung up is worth nothing. */
export function calleeAmdOptions(): {
  interruptOnMachine: false;
  participantIdentity: string;
  detectionTimeoutMs: number;
  waitUntilFinished: false;
} {
  return {
    interruptOnMachine: false,
    participantIdentity: CALLEE_PARTICIPANT_IDENTITY,
    detectionTimeoutMs: AMD_DETECTION_TIMEOUT_MS,
    waitUntilFinished: false,
  };
}
