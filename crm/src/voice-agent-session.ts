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
//     other. (Non-interruptibility itself — `allowInterruptions: false` — is enforced
//     where `say` is implemented, in the worker's plumbing.)
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

/** What this module needs from the live media session — implemented by the worker's
 *  plumbing over `AgentSession`, faked in tests. */
export interface ScriptedVoiceSession {
  /** Speak one utterance and resolve when it has been SAID — awaited, non-interruptible
   *  (`allowInterruptions: false`, the #2108 guard), never preemptive (#2059). */
  say(text: string): Promise<void>;
  /** The next FINAL user transcript (`user_input_transcribed` with `isFinal`), or null if
   *  none arrives within `timeoutMs` — the per-turn watchdog. */
  nextFinalTranscript(timeoutMs: number): Promise<string | null>;
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

  let answersPersisted = 0;
  let reachedOrdinal = 0;
  let consecutiveSilences = 0;
  let askedAll = false;

  for (const [i, prompt] of job.prompts.entries()) {
    await deps.session.say(prompt.promptText); // one at a time, awaited
    const transcript = await deps.session.nextFinalTranscript(ANSWER_WATCHDOG_MS);
    if (transcript !== null && transcript.trim() !== "") {
      // Committed NOW, not at hang-up and never in a shutdown hook (#2157).
      await deps.persistAnswer(prompt.id, transcript);
      reachedOrdinal = i + 1;
      await deps.reached(reachedOrdinal);
      answersPersisted += 1;
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
