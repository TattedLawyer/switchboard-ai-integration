// Call spike — the vendor seam. The call twin of `email-transport.ts`: the ONLY file in
// this repo that can open a signalling session to a telephony vendor. The vendor is
// LiveKit (T16): `livekitPlaceCall` below dispatches the agent worker, creates the SIP
// participant through the provisioned outbound trunk, and waits for the worker's raw
// report. No credentials exist yet — the adapter is built and pinned entirely against an
// injected client, and a fully-configured env engages it through `scripts/executor-loop.ts`.
//
// DEPENDENCY TRADE (recorded, not discovered): this file buys `livekit-server-sdk` (^2.18)
// for the `crm` workspace — the REST/Twirp control plane only (AgentDispatchClient,
// SipClient, RoomServiceClient; JWT + fetch underneath, no media stack). The conversation
// side (`@livekit/agents` + the Gemini plugin) is DELIBERATELY NOT a `crm` dependency: the
// agent worker is a separate process (`voice-agent/worker.ts`) precisely so the ONNX/LLM
// stack never enters this workspace — see that file's header.
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
import { AgentDispatchClient, RoomServiceClient, SipClient } from "livekit-server-sdk";
import type { CallContext, KnowledgeLookupOutcome, PlaceCall } from "./executor.js";
import type { ConversationOutcome, TransportSignal } from "./disposition.js";
import { encodeCallJobMetadata, parseAgentCallReport } from "./call-bridge.js";

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
 * The explicit config surface the LiveKit adapter needs (T16: LiveKit + SIP trunk + a
 * realtime voice model behind the seam). Injected from the composition root
 * (`scripts/executor-loop.ts`), never read from `process.env` here — the file-header
 * doctrine.
 */
export interface LiveKitCallConfig {
  /** LiveKit server URL (wss://… or https://…). */
  url: string;
  apiKey: string;
  apiSecret: string;
  /** The provisioned OUTBOUND SIP trunk this deployment dials through. */
  sipTrunkId: string;
  /** The agent name the worker registers under (`voice-agent/worker.ts` must use the
   *  SAME name, or every dispatch waits for a worker that never claims it). */
  agentName: string;
  /** The realtime voice model's credential (Gemini Live per T16). Not used by this
   *  process — validated here so a half-configured deployment dies at composition time
   *  instead of dispatching jobs to a worker that cannot speak. */
  modelApiKey: string;
}

/**
 * The structural client seam — the call twin of `email-transport.ts`'s `MailTransport`:
 * exactly what the adapter needs from the vendor, so a fake can stand in without tests
 * reaching for `any`, and so no test can touch a socket. The REAL one is
 * `realLiveKitCallClient` below; `livekitPlaceCall` constructs it only when none is
 * injected.
 */
export interface LiveKitCallClient {
  /** `agentDispatch.createDispatch(roomName, agentName, { metadata })`. MUST be called
   *  BEFORE the SIP participant is created: the worker starts AMD on join, and audio that
   *  arrives before the agent exists is audio AMD never hears. */
  dispatchAgent(roomName: string, agentName: string, metadata: string): Promise<void>;
  /** `sip.createSipParticipant(trunkId, number, roomName, opts)` — trunk/number/room are
   *  POSITIONAL on the SDK; the trunk id and dial options are config, bound inside the
   *  real client. Resolves only when ANSWERED (`waitUntilAnswered`); a failed dial throws
   *  `SipCallError`/`ServerError`, decoded by the adapter, never by callers. */
  dialSipParticipant(roomName: string, phoneE164: string): Promise<{ sipCallId: string }>;
  /** Resolves with the worker's raw report (room metadata, `call-bridge.ts` grammar) once
   *  published; REJECTS on timeout or a room that vanished without one. */
  awaitCallReport(roomName: string): Promise<string>;
  /** The documented hangup: deleting the room drops the PSTN leg AND the agent job.
   *  (`session.shutdown()` alone leaves the caller in silence.) */
  deleteRoom(roomName: string): Promise<void>;
}

/** A mid-call/never-connected vendor failure with NO SIP status to report. Typed so the
 *  executor's log can tell an honest transport death from a refusal; the proposal stays
 *  `executing` and T13's reconcile lists it (contract rule 2). */
export class LiveKitCallFailed extends Error {}

/** Ringing budget, seconds. LiveKit documents an 80s cap on `ringingTimeout`. */
const RINGING_TIMEOUT_S = 60;
/** Hard ceiling on one intake call, seconds. A questionnaire that needs more than 15
 *  minutes is a wedged conversation, not a long one. */
const MAX_CALL_DURATION_S = 15 * 60;
/** The SDK's own request timeout for the answered-dial round trip (its default is 30s,
 *  which is SHORTER than a legal ring — an undeclared trap). Ring budget plus grace. */
const DIAL_REQUEST_TIMEOUT_S = RINGING_TIMEOUT_S + 15;
/** How often the real client polls room metadata for the worker's report. */
const REPORT_POLL_INTERVAL_MS = 2_000;
/** How long the real client waits for the report before declaring the call lost: the
 *  call's own ceiling plus grace for the worker's goodbye and teardown. */
const REPORT_DEADLINE_MS = (MAX_CALL_DURATION_S + 60) * 1_000;

/** Loud, itemised construction-time validation. Exported for nobody; the pin (L1) goes
 *  through `livekitPlaceCall`. */
function validateConfig(cfg: LiveKitCallConfig): void {
  const missing = (Object.keys(cfg) as Array<keyof LiveKitCallConfig>).filter(
    (k) => typeof cfg[k] !== "string" || cfg[k].trim() === "",
  );
  if (missing.length > 0) {
    throw new Error(
      `LiveKit call config is incomplete — missing/empty: ${missing.join(", ")}. ` +
        `Refusing at construction: a PlaceCall that fails per call would wedge approved ` +
        `cards 'executing' one by one.`,
    );
  }
  if (!/^(wss|https):\/\//.test(cfg.url)) {
    throw new Error(
      `LiveKit call config: url ${JSON.stringify(cfg.url)} is not a LiveKit server URL ` +
        `(wss:// or https://)`,
    );
  }
}

/**
 * The REAL vendor client — the only construction of the SDK's three control-plane clients
 * in the repo. Never constructed by any test (L8's fetch tripwire would catch a slip):
 * tests inject fakes through `livekitPlaceCall`'s second parameter.
 */
export function realLiveKitCallClient(cfg: LiveKitCallConfig): LiveKitCallClient {
  // The SDK's clients want the HTTP host for Twirp; it accepts wss and rewrites, but be
  // explicit rather than lucky.
  const host = cfg.url.replace(/^wss:\/\//, "https://");
  const dispatch = new AgentDispatchClient(host, cfg.apiKey, cfg.apiSecret);
  const sip = new SipClient(host, cfg.apiKey, cfg.apiSecret);
  const rooms = new RoomServiceClient(host, cfg.apiKey, cfg.apiSecret);

  return {
    dispatchAgent: async (roomName, agentName, metadata) => {
      await dispatch.createDispatch(roomName, agentName, { metadata });
    },
    dialSipParticipant: async (roomName, phoneE164) => {
      const info = await sip.createSipParticipant(cfg.sipTrunkId, phoneE164, roomName, {
        participantIdentity: "phone-callee",
        // Resolve on ANSWER, not on request-accepted: the resolution itself is the 200.
        waitUntilAnswered: true,
        ringingTimeout: RINGING_TIMEOUT_S,
        maxCallDuration: MAX_CALL_DURATION_S,
        // She is not on this call; there is nobody to play a dialtone to, and a second
        // audio source is exactly the correlate of agents-js #1248 (outbound SIP audio
        // death alongside a second track).
        playDialtone: false,
        timeout: DIAL_REQUEST_TIMEOUT_S,
      });
      return { sipCallId: String(info.sipCallId ?? "") };
    },
    awaitCallReport: async (roomName) => {
      const deadline = Date.now() + REPORT_DEADLINE_MS;
      // Track the last metadata seen so a room that closes right after publishing (the
      // worker's report-then-hangup order) still yields its report.
      let lastSeen = "";
      for (;;) {
        const listed = await rooms.listRooms([roomName]);
        const room = listed.find((r) => r.name === roomName);
        if (room === undefined) {
          if (lastSeen !== "") return lastSeen;
          throw new LiveKitCallFailed(
            `room ${roomName} is gone and the agent never published a report — a mid-call ` +
              `death; whatever answers the worker persisted before it stand (rule 2)`,
          );
        }
        if (room.metadata !== "") lastSeen = room.metadata;
        if (lastSeen !== "") return lastSeen;
        if (Date.now() > deadline) {
          throw new LiveKitCallFailed(
            `timed out after ${REPORT_DEADLINE_MS}ms waiting for the agent's report in ` +
              `room ${roomName}`,
          );
        }
        await new Promise((r) => setTimeout(r, REPORT_POLL_INTERVAL_MS));
      }
    },
    deleteRoom: async (roomName) => {
      await rooms.deleteRoom(roomName);
    },
  };
}

/**
 * Decode a failed dial. The SDK throws `SipCallError` whose `sipStatusCode` getter reads
 * `metadata.sip_status_code` — but the upgrade from plain `ServerError` is CONDITIONAL on
 * that metadata being present, so this reads the metadata itself and duck-types the
 * getter, and returns undefined when no SIP status exists to report.
 */
function extractSipStatusCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { sipStatusCode?: unknown; metadata?: Record<string, unknown> };
  if (typeof e.sipStatusCode === "number" && Number.isFinite(e.sipStatusCode)) {
    return e.sipStatusCode;
  }
  const raw = e.metadata?.["sip_status_code"];
  if (raw === undefined || raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The real adapter's factory.
 *
 * 🚨 IT VALIDATES AT CONSTRUCTION, not per call (L1 — the property carried forward from
 * the unimplemented era's P6). A returned `PlaceCall` that throws on config would be
 * invoked AFTER `beginExecution`, wedging every approved card `executing` one by one; a
 * factory that throws stops the daemon at composition time, before any proposal is
 * claimed.
 *
 * 🚨 THE CLIENT IS INJECTED, the `smtpSender` doctrine: tests hand in a fake and can never
 * touch a socket; only a caller that omits it (the composition root) gets the real one.
 *
 * HOW THE 4-RULE CONTRACT IS MET ACROSS TWO PROCESSES: the conversation runs in the agent
 * worker (`voice-agent/worker.ts`), not here, so:
 *   1. STREAM, NEVER BUFFER — the WORKER commits each answer to `crm.answers` the moment
 *      it is final (`recordAnswer`, per turn — also the guard for agents-js #2157, which
 *      can skip shutdown callbacks entirely). This adapter therefore does NOT invoke
 *      `ctx.answer`/`ctx.reached`: the same answer must not have two writers. Nothing
 *      anywhere buffers to flush at hang-up.
 *   2. DIE HONESTLY — no SIP status, no report, a malformed report: cleanup, then a typed
 *      `LiveKitCallFailed` throw. Never a synthesized `CallResult`.
 *   3. REPORT RAW SIGNALS, DECIDE NOTHING — a resolved answered-dial is the documented
 *      200 (voicemail included); a failed dial returns its raw `sipStatusCode`; the
 *      `amdResult` and conversation outcome are the worker's report verbatim.
 *   4. DIAL EXACTLY ONCE — one `createSipParticipant`, ever, per placed call; a second
 *      invocation throws before touching the vendor. The opening line rides to the worker
 *      in the job metadata VERBATIM (`call-bridge.ts`), never templated.
 */
export function livekitPlaceCall(
  cfg: LiveKitCallConfig,
  client?: LiveKitCallClient,
): PlaceCall {
  validateConfig(cfg);
  const lk = client ?? realLiveKitCallClient(cfg);

  let dialed = false;
  return async (ctx: CallContext) => {
    if (dialed) {
      throw new Error(
        "livekitPlaceCall: this call was already placed — rule 4, dial exactly once; " +
          "no fallback number, no vendor-side retry",
      );
    }
    dialed = true;

    const roomName = `call-${ctx.touchId}`;

    // Everything the worker needs to run HER call and nothing else — the approved words
    // verbatim, the touch to persist into, the bound question ids (call-bridge grammar).
    const metadata = encodeCallJobMetadata({
      v: 1,
      touchId: ctx.touchId,
      contactId: ctx.payload.contact_id,
      displayName: ctx.payload.display_name,
      openingLine: ctx.payload.opening_line,
      prompts: ctx.prompts.map((p) => ({
        id: p.id,
        questionKey: p.questionKey,
        promptText: p.promptText,
      })),
    });

    // The explicit hangup. Used on every non-returning path; the worker owns the hangup
    // on the paths where a conversation happened. Cleanup failure is logged, never thrown
    // over the signal we are trying to surface.
    const cleanup = async (why: string): Promise<void> => {
      try {
        await lk.deleteRoom(roomName);
      } catch (err) {
        console.error(
          `[call] cleanup deleteRoom(${roomName}) failed after ${why}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    };

    // 1. Agent FIRST, so it is in the room running AMD before any callee audio can exist
    //    (early audio lost to a late agent is an AMD that reports `uncertain` forever).
    await lk.dispatchAgent(roomName, cfg.agentName, metadata);

    // 2. The one dial.
    try {
      await lk.dialSipParticipant(roomName, ctx.payload.phone_e164);
    } catch (err) {
      const sipStatus = extractSipStatusCode(err);
      if (sipStatus !== undefined) {
        // A failed dial WITH a SIP status is a normal outcome, not an error: return the
        // raw code (486 vs 603 survive only here — DisconnectReason cannot tell them
        // apart) and let `disposition.ts` alone decide what it means.
        //
        // 🚨 EXPLICIT SHUTDOWN, not trust: LiveKit does NOT auto-close the session on
        // USER_UNAVAILABLE (408/480) or SIP_TRUNK_FAILURE (5xx) — and no-answer is the
        // MAJORITY outcome of an outbound dialer, so skipping this leaks a dispatched
        // agent job on most calls. Deleting the room on the auto-closing codes too is a
        // no-op by then, and cheaper than modelling the vendor's split.
        await cleanup(`dial failed with SIP ${sipStatus}`);
        return { transport: { sipStatus }, conversation: null };
      }
      // No SIP status exists to report (plain ServerError, a timeout, a string). Rule 2:
      // clean up, then die honestly — never invent a signal.
      await cleanup("a dial failure with no SIP status");
      throw new LiveKitCallFailed(
        `dial failed with no SIP status to report: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    // 3. Answered — the documented meaning of a resolved waitUntilAnswered dial is 200,
    //    and voicemail ALSO arrives here (it answers with 200 OK at the SIP layer; the
    //    worker's AMD result is what tells them apart, and `disposition.ts` is who reads
    //    it). Wait for the worker's raw report.
    let raw: string;
    try {
      raw = await lk.awaitCallReport(roomName);
    } catch (err) {
      await cleanup("the report never arrived");
      throw new LiveKitCallFailed(
        `answered, but the agent's report never arrived — mid-call death; per-turn ` +
          `answers already persisted by the worker stand: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    let report;
    try {
      report = parseAgentCallReport(raw);
    } catch (err) {
      await cleanup("an unparseable report");
      throw new LiveKitCallFailed(
        `answered, but the agent's report does not parse: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    // Raw signals through, decided by nobody here. On this path the WORKER hangs up
    // (report first, then room deletion — its pinned order), so no cleanup call.
    return {
      transport: { sipStatus: 200, amdResult: report.amdResult },
      conversation: report.conversation,
    };
  };
}
