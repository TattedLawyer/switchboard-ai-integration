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
  /** Speak one utterance's SUBSTANCE and resolve when it has been said — awaited, one at
   *  a time, never preemptive (#2059). The live implementation is
   *  `realtimeScriptedSpeech` below: `generateReply` on the native-audio session (the
   *  model owns phrasing, this loop owns everything decidable), bounded by the speak
   *  watchdog. Interruptible by the caller — barge-in is natural conversation, and the
   *  library forces it anyway on a server-turn-detection realtime model. */
  say(text: string): Promise<void>;
  /** The next FINAL user transcript, or null if none arrives within `timeoutMs` — the
   *  per-turn watchdog. The live worker queues `conversation_item_added` user items,
   *  which PRESERVE the turn-start time as `item.createdAt` — NOT
   *  `user_input_transcribed`, which drops `turnStartedAt` on the floor (events.d.ts:
   *  the transcribed event carries no turn time at all). A bare string is a transcript
   *  with NO usable turn time; it binds to the question currently being waited on (the
   *  conservative fallback — see the binding loop). */
  nextFinalTranscript(timeoutMs: number): Promise<TimedTranscript | string | null>;
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
  await deps.session.say(job.openingLine); // verbatim — she approved those words (rule 4)

  const now = deps.now ?? (() => Date.now());

  let answersPersisted = 0;
  let reachedOrdinal = 0;
  let consecutiveSilences = 0;
  let askedAll = false;

  // WHEN each question was ASKED — the clock reading taken as its utterance BEGINS,
  // because barge-in is allowed: a caller who starts answering while the question is
  // still being spoken is answering THIS question, not the previous one. Together with
  // `answered` this is the binding table for late transcripts.
  const askedAt: number[] = [];
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

  for (const [i, prompt] of job.prompts.entries()) {
    askedAt[i] = now();
    await deps.session.say(prompt.promptText); // one at a time, awaited

    // THE BINDING LOOP — the late-transcript fix. The Google plugin emits a final
    // transcript only after the model's reply finishes generating — "seconds after the
    // user spoke" (realtime_api.js:929–935, verbatim) — so the FIFO the seam delivers
    // can hand this turn a straggler that answers an EARLIER question; consumed blindly
    // (the old shape) it was persisted under the FOLLOWING question's id: silent data
    // corruption. Every transcript is therefore bound by its TURN-START time against
    // the asked-at table:
    //   · no turn time            -> the open question. The conservative fallback:
    //     without a timestamp staleness cannot be proven, and dropping would kill every
    //     intake on a provider that omits `turnStartedAt` — this degrades to exactly
    //     the pre-fix arrival-order behaviour, never worse.
    //   · began at/after this ask -> the open question.
    //   · began before this ask   -> the question that was OPEN when the turn began:
    //     filed there iff that question is still unanswered, otherwise DROPPED. Never
    //     misfiled. A turn from before ANY question (AMD-window speech, the reply to
    //     the opening line) binds to nothing and is dropped — which subsumes and widens
    //     the worker's old one-shot drop-stale point (that cleared only what AMD
    //     consumed, and missed the eager "yes, speaking" reply the worker header used
    //     to flag as an open first-live-call hazard).
    const waitStarted = now();
    let budget = ANSWER_WATCHDOG_MS;
    let gotAnswer = false;
    while (budget > 0) {
      const raw = await deps.session.nextFinalTranscript(budget);
      if (raw === null) break; // the watchdog's silence signal
      const timed: TimedTranscript = typeof raw === "string" ? { transcript: raw } : raw;
      if (timed.transcript.trim() === "") break; // whitespace is silence, not an answer
      if (timed.turnStartedAt === undefined || timed.turnStartedAt >= askedAt[i]!) {
        await commit(i, timed.transcript);
        gotAnswer = true;
        break;
      }
      // A straggler: its turn began before this question was asked. Find the question
      // that was open then — the LATEST one asked at or before the turn began.
      let openThen = -1;
      for (let k = i - 1; k >= 0; k -= 1) {
        if (askedAt[k]! <= timed.turnStartedAt) {
          openThen = k;
          break;
        }
      }
      if (openThen >= 0 && !answered[openThen]) {
        await commit(openThen, timed.transcript);
        consecutiveSilences = 0; // someone is demonstrably talking to us
      }
      // else: dropped — pre-question speech, or an echo of a question already answered.
      budget = ANSWER_WATCHDOG_MS - (now() - waitStarted); // the deadline never resets
    }
    if (gotAnswer) {
      consecutiveSilences = 0;
    } else {
      // The watchdog: silence advances the script instead of hanging it.
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
}

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
 * cadence the owner refuses to ship. The model now owns PHRASING: natural delivery and a
 * brief acknowledgement of what the caller just said. The loop keeps everything
 * decidable — which question is open, the order, when to advance, what persists. The
 * three prohibitions that survive the loosening are the ones that keep the call HERS:
 * never invent questions she never approved, never change what a question is ASKING,
 * never claim to have taken any action.
 */
export const INTAKE_INSTRUCTIONS =
  "You are making a brief, friendly intake call on behalf of a real-estate broker. You " +
  "will be handed the call's content one piece at a time; every piece is approved in " +
  "substance. Deliver each one naturally in your own words — warm, plain, and concise, " +
  "like a considerate human caller — and briefly acknowledge what the person just said " +
  "when it helps the conversation flow. Never invent questions you were not handed, " +
  "never change what a handed question is asking, and never claim to have taken, " +
  "scheduled, or promised any action. Ask one thing at a time, then stop and listen. " +
  "If the caller speaks between pieces, respond briefly and naturally without asking " +
  "anything new, and wait to be handed the next piece.";

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
 * `generateReply` turn out. Per turn: arm the observer, generate, race playout against
 * the speak watchdog, then decide —
 *   · playout resolved AND audio left        -> normal return;
 *   · watchdog expired BUT audio left        -> normal return: the agent spoke and is
 *     merely slow (a long courteous turn must not kill the call); a truly dead call is
 *     still bounded by the answer watchdog and MAX_CONSECUTIVE_SILENCES;
 *   · `exception()` returned a stashed error -> THROW it (the one path that populates
 *     the stash);
 *   · NO audio left, however the race ended  -> THROW, naming the utterance and which
 *     condition fired.
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
  opts?: { observer?: SpeechDeliveryObserver; watchdogMs?: number },
): (utterance: string) => Promise<void> {
  const observer = opts?.observer ?? TRUST_PLAYOUT_OBSERVER;
  const watchdogMs = opts?.watchdogMs ?? SPEAK_WATCHDOG_MS;
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
      throw new Error(
        outcome === "playout"
          ? `utterance ${JSON.stringify(utterance)} silently failed: playout resolved ` +
            `but no audio ever reached the room (SpeechHandle._markDone resolves ` +
            `instead of rejecting — livekit/agents #6224, fix rejected upstream)`
          : `utterance ${JSON.stringify(utterance)} silently failed: the speak ` +
            `watchdog (${watchdogMs}ms) expired and no audio ever reached the room`,
      );
    }
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
