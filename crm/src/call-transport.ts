// Call spike — the vendor seam. The call twin of `email-transport.ts`: when a telephony
// vendor exists, this will be the ONLY file in this repo that can open a media session to
// one. Today it is the one file that deliberately cannot — no vendor account exists, so no
// vendor dependency exists, and nothing in here can reach a telephone.
//
// 🚨 CONFIG IS INJECTED, NEVER READ FROM `process.env` IN THIS MODULE — the same doctrine
// as `smtpSender`'s constructor arguments and the executor's injected allowlist
// (`executor.ts`): the thing that touches the outside world takes its authority explicitly,
// so a debug script cannot inherit whatever happened to be in the environment.
//
// ═══ THE CONTRACT ANY REAL `PlaceCall` MUST SATISFY ═══ (these are acceptance criteria,
// not aspirations — a vendor adapter that violates any of them is wrong even if every test
// it was shipped with is green):
//
// 1. STREAM, NEVER BUFFER. Call `ctx.answer(...)` the moment each answer exists and
//    `ctx.reached(...)` as each question is reached. A vendor that buffers answers and
//    flushes them at hang-up silently converts the no-rollback guarantee in `executor.ts`'s
//    header into fiction: a mid-call death would then lose everything the prospect said,
//    when the entire point of committing DURING the call is that what she said is TRUE and
//    is the only record of it.
//
// 2. DIE HONESTLY. On a mid-call transport failure, THROW — never synthesize a
//    `CallResult`. A fabricated result drives `finishExecution({ok:true})` and an invented
//    disposition, destroying the `executing`-wedge visibility that reconcile's
//    stuck-execution report depends on. A wedged card a human can see beats a false
//    outcome nobody can.
//
// 3. REPORT RAW SIGNALS, DECIDE NOTHING. Return the true SIP status and the true AMD
//    result; `disposition.ts` is the sole authority on what they mean. Voicemail MUST
//    arrive as `sipStatus: 200, amdResult: "machine"` — voicemail systems answer with a
//    200 OK at the SIP layer (the trap `disposition.ts` documents), so a transport that
//    "helpfully" maps it to anything else pre-empts the one function allowed to interpret.
//    An inconclusive AMD stays `"unknown"`, never laundered to `"human"`.
//
// 4. DIAL `payload.phone_e164` EXACTLY ONCE — no fallback number, no vendor-side retry:
//    the approved payload names ONE number, and a second dial is a call the human never
//    approved. Speak `payload.opening_line` exactly as bound; nothing is templated at
//    call time — she approved those words.
import type { KnowledgeLookupOutcome, PlaceCall } from "./executor.js";
import type { ConversationOutcome, TransportSignal } from "./disposition.js";

/**
 * The stub. The call twin of the loop's `stubSender`, with one improvement: it is
 * type-checked against the real `PlaceCall` (this file is inside `crm`'s tsconfig; the
 * loop sits outside every tsconfig, which is how its snake_case bug shipped).
 *
 * It NEVER opens a socket, never invokes `ctx.answer` or `ctx.reached` (nobody rang, so
 * nobody said anything), and returns a canned no-answer — 480 Temporarily Unavailable —
 * which `disposition.ts` resolves to `no_answer`. Honest by construction: a rehearsal
 * reports that nobody was reached, never that somebody was.
 */
export const stubPlaceCall: PlaceCall = async (ctx) => {
  console.log(
    `[call] STUB CALL to=${ctx.payload.phone_e164} touch=${ctx.touchId} — ` +
      `no socket opened, nobody rang; returning canned no-answer (480)`,
  );
  return { transport: { sipStatus: 480 }, conversation: null };
};

/** One scripted exchange: what the fake prospect ASKS before answering (each ask is one
 *  knowledge lookup), and what they ANSWER to the current approved question. */
export interface ScriptedTurn {
  /** Questions the prospect throws at the agent before answering this prompt. */
  asks?: string[];
  /** The prospect's answer to prompt N — committed via `ctx.answer` the moment it exists. */
  answer: string;
}

/** A whole scripted conversation, plus the RAW signals it ends with (rule 3: the script
 *  reports signals; `disposition.ts` alone decides what they mean). */
export interface CallScript {
  turns: ScriptedTurn[];
  transport: TransportSignal;
  conversation: ConversationOutcome | null;
}

/** What one ask brought back — the executor's outcome verbatim, or the honest admission
 *  that no knowledge base exists on this call (`ctx.lookupKnowledge` absent). */
export interface ScriptedLookup {
  question: string;
  outcome: KnowledgeLookupOutcome | "no-knowledge-base";
}

/** Filled in AS THE CALL RUNS, so a test (or a rehearsal operator) can see exactly what
 *  reached the adapter, in order. */
export interface ScriptedCallLog {
  /** `payload.opening_line`, verbatim — rule 4: she approved those words. */
  openingSpoken: string | null;
  lookups: ScriptedLookup[];
}

export interface ScriptedCall {
  placeCall: PlaceCall;
  log: ScriptedCallLog;
}

/**
 * The FAKE VENDOR — a scripted caller that proves the whole loop with no carrier account:
 * it "answers", hears the opening line, interjects knowledge questions, and works through
 * the approved question list, honouring this file's 4-rule contract:
 *   1. STREAM, NEVER BUFFER — `ctx.answer`/`ctx.reached` fire per turn, mid-call, so a
 *      script that dies half-way leaves exactly the answers already given (the
 *      no-rollback guarantee stays true even in rehearsal).
 *   2. DIE HONESTLY — a script that disagrees with the approved prompt list (more turns
 *      than questions) THROWS; it never invents a `CallResult` around the mismatch.
 *   3. REPORT RAW SIGNALS, DECIDE NOTHING — `script.transport`/`script.conversation` are
 *      returned verbatim; fewer turns than prompts is simply a caller who hung up early,
 *      and the script's own signals say so.
 *   4. DIAL EXACTLY ONCE — a second invocation of the same scripted call THROWS, and the
 *      opening line is logged exactly as bound, never templated.
 *
 * When the script asks and the call carries NO knowledge base (`ctx.lookupKnowledge`
 * absent), the log records "no-knowledge-base" and the intake continues — the agent
 * without knowledge is still an agent with a questionnaire.
 */
export function scriptedPlaceCall(script: CallScript): ScriptedCall {
  const log: ScriptedCallLog = { openingSpoken: null, lookups: [] };
  let dialed = false;
  const placeCall: PlaceCall = async (ctx) => {
    if (dialed) {
      throw new Error("scriptedPlaceCall: this call was already placed — rule 4, dial exactly once");
    }
    dialed = true;
    if (script.turns.length > ctx.prompts.length) {
      throw new Error(
        `scriptedPlaceCall: the script answers ${script.turns.length} questions but the ` +
          `approved set has ${ctx.prompts.length} — refusing to invent prompts (rule 2)`,
      );
    }
    log.openingSpoken = ctx.payload.opening_line;
    for (const [i, turn] of script.turns.entries()) {
      for (const question of turn.asks ?? []) {
        if (ctx.lookupKnowledge === undefined) {
          log.lookups.push({ question, outcome: "no-knowledge-base" });
        } else {
          log.lookups.push({ question, outcome: await ctx.lookupKnowledge({ text: question }) });
        }
      }
      // Committed NOW, not at hang-up (rule 1).
      await ctx.answer(ctx.prompts[i].id, turn.answer);
      await ctx.reached(i + 1);
    }
    return { transport: script.transport, conversation: script.conversation };
  };
  return { placeCall, log };
}

/**
 * The explicit config surface a real LiveKit adapter needs (T16: LiveKit + SIP trunk +
 * a realtime voice model behind the seam). Declared NOW so the shape is compiler-checked
 * and the composition root can be written against it, even though nothing implements it.
 */
export interface LiveKitCallConfig {
  /** LiveKit server URL (wss://…). */
  url: string;
  apiKey: string;
  apiSecret: string;
  /** The provisioned SIP trunk this deployment dials out through. */
  sipTrunkId: string;
  /** The realtime voice model's credential (Gemini Live per T16). */
  modelApiKey: string;
}

/**
 * The real adapter's factory — TYPE-CHECKED and DELIBERATELY UNIMPLEMENTED.
 *
 * 🚨 IT THROWS AT CONSTRUCTION, not per call. A returned `PlaceCall` that throws would be
 * invoked AFTER `beginExecution`, wedging every approved card `executing` one by one; a
 * factory that throws stops the daemon at composition time, before any proposal is
 * claimed. Misconfiguration dies loudly at startup instead of consuming approvals.
 */
export function livekitPlaceCall(cfg: LiveKitCallConfig): PlaceCall {
  void cfg;
  throw new Error(
    "livekitPlaceCall is not implemented — no vendor credentials wired yet (T16). " +
      "The stub stands until a real trunk exists; nothing here pretends to dial.",
  );
}
