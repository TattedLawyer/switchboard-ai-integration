// The agent WORKER — the conversation half of the call vendor (T16), and a COMPOSITION
// ROOT: the same standing as `scripts/executor-loop.ts` (outside every tsconfig, allowed
// to read env and cross workspaces by relative import), and the same discipline — this
// file is PLUMBING ONLY. Every decidable behaviour (the script order, per-turn
// persistence, the watchdog, the AMD vocabulary, complete-vs-cut_off, report-then-hangup)
// lives in `crm/src/voice-agent-session.ts` + `crm/src/call-bridge.ts`, where the compiler
// and the pins can see it. A real bug shipped in the executor loop because it sat outside
// every typecheck; this file holds as little as that lesson allows.
//
// WHY THIS DIRECTORY IS NOT A WORKSPACE (the other half of the dependency trade recorded
// in `crm/src/call-transport.ts`): `@livekit/agents` + the Google plugin pull an
// ONNX/media/LLM stack. Making this a workspace would install all of it on every
// `npm install` at the root, onto machines that will never run a call. It stays a
// standalone package: `cd voice-agent && npm install`, only where the worker runs.
//
// WHO TALKS TO WHOM: `livekitPlaceCall` (executor daemon) dispatches this agent by NAME
// into a per-call room with the job metadata, THEN dials the SIP participant into the
// same room. This worker parses the metadata (loudly — a foreign or empty job is refused,
// `call-bridge.ts`), runs AMD, runs the scripted intake, persists every answer AS IT
// ARRIVES into `crm.answers` (as `switchboard_crm`, whose 016 grants cover exactly these
// writes), publishes the raw report as room metadata, and hangs up by DELETING THE ROOM —
// the documented way to drop the PSTN leg (`session.shutdown()` alone leaves the caller
// in silence).
//
// KNOWN UPSTREAM BUGS, and where each guard lives (issue numbers are livekit/agents-js):
//   #2249 `toolChoice:'none'` can permanently wedge Gemini Live's mic -> this agent
//         defines ZERO TOOLS (see `new voice.Agent` below). Consequence, recorded in the
//         deferred register: NO mid-call knowledge lookups on the live path — the model
//         has no tool with which to ask. `scriptedPlaceCall` keeps the knowledge seam
//         exercised until the upstream fix.
//   #2108 400-after-barge-in loops and the agent goes silent -> barge-in CANNOT be
//         blocked on this stack (the library forces `allowInterruptions: true` for
//         `generateReply` under a server-turn-detection realtime model — and the owner
//         wants natural conversation, not an IVR that talks over people), so the wedge
//         is BOUNDED instead of prevented: the SPEAK watchdog releases a stuck
//         utterance and the per-turn ANSWER watchdog in `voice-agent-session.ts`
//         advances or ends the call. Silent death is impossible; a bounded pause is the
//         worst case.
//   #1248 outbound-SIP sample-rate mismatch kills agent→callee audio, correlated with a
//         second audio track -> exactly ONE audio track: no BackgroundAudioPlayer, no
//         filler audio, nothing here publishes but the session's own output.
//   #2157 teardown race SKIPS shutdown callbacks -> nothing of value happens at shutdown:
//         answers are persisted per turn and the report is published BEFORE the hangup
//         (both pinned in voice-agent-session.test.ts).
//   #2059 superseded speech handles repeat a sentence -> preemptive generation stays OFF
//         and utterances are spoken one at a time, each awaited to playout.
//
// MODEL: pinned. Do NOT move to a 3.1 model — the plugin gates mid-session updates on
// `!model.includes('3.1')` (verified in @livekit/agents-plugin-google@1.6.4,
// dist/realtime/realtime_api.cjs: `const mutableSession = !model.includes("3.1")`).
//
// Q/A ALIGNMENT: answers are bound by TURN-START time, not arrival order. The queue
// below carries `conversation_item_added` user items because that event PRESERVES when
// the caller's turn began (`item.createdAt` — agent_activity.js builds the user message
// with `createdAt: turnStartedAt`, and the plugin hands over the generation's creation
// timestamp, realtime_api.js:935); `user_input_transcribed` DROPS it. The binding rules
// — a straggler files against the question that was open when its turn began, or is
// dropped; never against the question currently waiting — live in
// `voice-agent-session.ts`'s intake loop, where the pins can see them. This closed the
// old eager-speaker hazard ("yes, speaking" landing as question 1's answer) and the
// late-straggler misfile. The 2026-08-22 leak call (touch `0fcf2180-…`) then proved the
// OTHER side of the comparison was still a lie: asked-at was stamped when the loop
// handed the question over, but the model often voices it seconds later or never — so
// `say` now reports DELIVERY and the loop binds against when each question actually
// REACHED THE CALLER'S EAR (`SpeechHandle.chatItems` -> assistant `createdAt =
// startedSpeakingAt`); a never-voiced question is re-asked, bounded, and can receive
// no answer at all. Decisions in voice-agent-session.ts; this file only feeds events.
import { fileURLToPath } from "node:url";
import pg from "pg";
import { RoomServiceClient } from "livekit-server-sdk";
import {
  type JobContext,
  WorkerOptions,
  cli,
  defineAgent,
  voice,
  waitForParticipant,
  waitForParticipantAttribute,
} from "@livekit/agents";
import * as google from "@livekit/agents-plugin-google";
import {
  CALLEE_PARTICIPANT_IDENTITY,
  encodeAgentCallReport,
  parseCallJobMetadata,
} from "../crm/src/call-bridge.js";
import {
  INTAKE_INSTRUCTIONS,
  SIP_CALL_STATUS_ACTIVE,
  SIP_CALL_STATUS_ATTRIBUTE,
  awaitCallAnswered,
  calleeAmdOptions,
  realtimeScriptedSpeech,
  runIntakeCall,
  startSessionBoundToCallee,
  type ScriptedVoiceSession,
} from "../crm/src/voice-agent-session.js";
import { recordAnswer } from "../crm/src/answers.js";

/** Pinned (see header). NOT 3.1. */
const VOICE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    // LOUD OR NOT AT ALL: an empty or foreign job (`ctx.job.metadata` is a plain string
    // and may legitimately be empty) is refused before anything joins the call.
    const job = parseCallJobMetadata(ctx.job.metadata);
    const bound = job.prompts.map((p) => p.id);

    // The worker holds the same two credentials the executor daemon composes with: the
    // CRM role for per-turn persistence, LiveKit for the report + hangup. Env reads are
    // legal HERE and only here — this file is a composition root.
    const crmDb = new pg.Pool({ connectionString: required("CRM_DATABASE_URL") });
    const rooms = new RoomServiceClient(
      required("LIVEKIT_URL").replace(/^wss:\/\//, "https://"),
      required("LIVEKIT_API_KEY"),
      required("LIVEKIT_API_SECRET"),
    );

    try {
      await ctx.connect();
      const roomName = ctx.room.name ?? `call-${job.touchId}`;

      const session = new voice.AgentSession({
        llm: new google.beta.realtime.RealtimeModel({
          model: VOICE_MODEL,
          apiKey: required("CALL_MODEL_API_KEY"),
          // 🚨 DUPLICATED, NOT MOVED — the same constant is ALSO passed to `new
          // voice.Agent` below, and that is load-bearing, not sloppy.
          //
          // WHY IT IS HERE: only the constructor option becomes a real
          // `setup.systemInstruction` on the FIRST connect (plugin
          // realtime_api.ts:1505-1512). Passing instructions ONLY via the Agent means
          // the activity start pushes them through `updateInstructions`, which calls
          // `markRestartNeeded()` when no session is live yet (realtime_api.ts:678-693
          // -> :583-588) — a connect/close/reconnect visible in the 2026-08-21 live log
          // as `sessionShouldClose: true` at 17:18:38.021, 0.479s of pointless churn
          // before a single word is spoken.
          //
          // WHY IT MUST ALSO STAY ON THE AGENT: activity start pushes the AGENT's
          // instructions unconditionally, and `updateInstructions` early-returns ONLY
          // when the incoming string EQUALS `options.instructions` (:678-681). Move it
          // off the Agent and the mismatch both restores the reconnect AND OVERWRITES
          // this system instruction on the restarted session. Same constant in both
          // places makes the check a no-op. Found by cold review before it shipped.
          instructions: INTAKE_INSTRUCTIONS,
        }),
        // #2059 guard: never preemptive. Explicit, not defaulted, so a library that
        // flips the default cannot flip us.
        preemptiveGeneration: false,
      });

      // AMD — constructed before the SIP participant can exist (the transport
      // dispatches this agent BEFORE dialling). 🚨 AMD's own SIP gate does NOT protect
      // the detection budget: in the installed 1.6.4 (dist/voice/amd.js) execute() arms
      // startDetectionTimer() immediately (line 245) and gateListening() RE-ARMS it at
      // track-subscribe (line 441) — both BEFORE its `sip.callStatus === 'active'`
      // wait; only the no-speech timer is answer-gated. So execute() below is gated on
      // the ANSWER by this worker itself (`awaitCallAnswered`), and `calleeAmdOptions()`
      // now pins THREE decisions: `interruptOnMachine: false` (the script never speaks
      // before the verdict, and the hangup is OURS — report first, then deleteRoom,
      // never the library's), `participantIdentity` — AMD restricted to the SAME
      // participant the transport dials (2026-08-21 live defect 1: with no binding, AMD
      // classified 20s of dead air while a human was talking) — and the raised
      // `detectionTimeoutMs` backstop (upstream fix is livekit/agents-js #2226, merged
      // after 1.6.4; both halves live in voice-agent-session.ts).
      const amd = new voice.AMD(session, calleeAmdOptions());
      // 🚨 execute() MOVED BELOW session.start(): AMD.execute() calls
      // session.pauseReplyAuthorization(), which throws "AgentSession is not running"
      // unless `session.activity` exists — and only start() creates it. Verified in
      // @livekit/agents/src/voice/amd.ts:397 and agent_session.ts:1211. Undocumented;
      // found by a real call that connected and died before speaking.

      // FINAL transcripts only, queued in arrival order WITH their turn-start time.
      // `conversation_item_added` (not `user_input_transcribed`, which drops the turn
      // time): agent_activity.js builds the user ChatMessage with
      // `createdAt: turnStartedAt` — the plugin's generation-creation timestamp
      // (realtime_api.js:935), stamped when the server took the turn, i.e. when the
      // caller SPOKE, seconds before the final transcript is emitted. The intake loop
      // in `voice-agent-session.ts` binds each transcript to the question that was open
      // at that moment; this queue just carries the facts.
      const finals: Array<{ transcript: string; turnStartedAt?: number }> = [];
      let wake: (() => void) | null = null;
      session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
        if (ev.item.type !== "message" || ev.item.role !== "user") return;
        const text = ev.item.textContent;
        if (text !== undefined && text.trim() !== "") {
          finals.push({ transcript: text, turnStartedAt: ev.item.createdAt });
          wake?.();
        }
      });

      // The speech observer for `realtimeScriptedSpeech` (the silent-utterance guard —
      // the decision lives in voice-agent-session.ts; this is only the event feed):
      // `agent_state_changed -> 'speaking'` is emitted from onFirstFrame, the first
      // real audio frame reaching the room — the one signal a generation that died
      // before producing sound can never emit. Since the 2026-08-22 leak-call fix the
      // feed also records WHEN: `firstFrameAtSinceArm` is the FALLBACK voiced-at the
      // adapter uses when the committed assistant item carries no time — the primary
      // source is `SpeechHandle.chatItems` (createdAt = startedSpeakingAt), which the
      // adapter reads off the real handle itself. `ev.createdAt` is stamped at emit
      // (events.ts:86, `Date.now()` — `_updateAgentState` does not forward the frame's
      // own startTime into the event, agent_session.ts:1717), which is synchronous with
      // onFirstFrame: an observation of the voicing, not the library's clock for it.
      let audioLeftSinceArm = false;
      let firstFrameAtSinceArm: number | undefined;
      session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
        if (ev.newState === "speaking") {
          audioLeftSinceArm = true;
          if (firstFrameAtSinceArm === undefined) firstFrameAtSinceArm = ev.createdAt;
        }
      });

      // THE OTHER HALF OF THE SAME GUARD (2026-08-22): evidence the CALLER spoke since
      // the turn was armed. A turn that produced no audio is a death ONLY if the caller
      // was also silent; if they were talking over us it is a barge-in, and throwing
      // hangs up on a present, engaged human — which is exactly what happened to the
      // owner mid-sentence. Fed from the same user-item stream the answer loop uses, so
      // it sees a caller turn as soon as the plugin reports one. The DECISION (grace
      // window, what counts) lives in voice-agent-session.ts; this is only the feed.
      let callerSpokeSinceArm = false;
      // 🚨 THE INTERIM STREAM, NOT `ConversationItemAdded`. The user-item event above
      // fires only on the FINAL transcript, which the plugin withholds until the model's
      // reply has finished generating — seconds after the caller actually spoke, and far
      // too late to save a turn that is about to be called a death. `UserInputTranscribed`
      // streams FRAGMENTS as they arrive (`realtime_api.ts:1701-1716`), which is the
      // earliest evidence this stack can give that a human is talking. It keeps flowing
      // even in the window where the plugin suppresses `input_speech_started` — the very
      // window that killed the 2026-08-22 call — which is what makes it the right feed.
      session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
        if (ev.transcript.trim() !== "") callerSpokeSinceArm = true;
      });

      // BOUND TO THE CALLEE (2026-08-21 live defect 1): `startSessionBoundToCallee`
      // passes `inputOptions.participantIdentity` — RoomIO's public linking contract —
      // so the session waits for, links, and SUBSCRIBES exactly the SIP participant the
      // transport dialled. Without it the caller's track stayed `subscribed:false` and
      // the agent heard nothing.
      // #1248 guard (unchanged): the session's own output is the ONLY audio track this
      // process publishes — no background audio, no filler, nothing else is started.
      await startSessionBoundToCallee(
        session,
        // ZERO TOOLS (#2249) — an empty Agent: no tools defined, no toolChoice sent.
        // INTAKE_INSTRUCTIONS (owner decision, see voice-agent-session.ts): substance is
        // approved, PHRASING is the model's — the old "speak only the exact scripted
        // utterances" prompt is retired with `say()` itself.
        new voice.Agent({ instructions: INTAKE_INSTRUCTIONS }),
        ctx.room,
      );

      // THE ANSWER GATE (half (a), decisions in voice-agent-session.ts): AMD starts
      // only once the callee's `sip.callStatus` reads 'active' — never on ringback.
      // Participant first: `waitForParticipantAttribute` THROWS if the identity is not
      // in the room yet, and the transport dials the SIP leg AFTER dispatching us.
      // `awaitCallAnswered` bounds the whole wait and throws on a never-answered call —
      // no AMD verdict, no script, no report (honesty rules; the transport's own dial
      // has already failed by then).
      await awaitCallAnswered(async (signal) => {
        await waitForParticipant({
          room: ctx.room,
          identity: CALLEE_PARTICIPANT_IDENTITY,
          signal,
        });
        await waitForParticipantAttribute({
          room: ctx.room,
          identity: CALLEE_PARTICIPANT_IDENTITY,
          attribute: SIP_CALL_STATUS_ATTRIBUTE,
          value: SIP_CALL_STATUS_ACTIVE,
          signal,
        });
      });

      // AMD starts HERE — the session is running (pauseReplyAuthorization succeeds) and
      // the call is ANSWERED (the detection budget times real speech, not ringback).
      const amdVerdict = amd.execute();

      const seam: ScriptedVoiceSession = {
        // 2026-08-21 live defect 2: `session.say()` is a TTS path and threw "trying to
        // generate speech from text without a TTS model" — this stack is NATIVE AUDIO.
        // `realtimeScriptedSpeech` speaks via `session.generateReply({ instructions })`
        // (the supported route on a realtime model), awaits playout (#2059: one at a
        // time), and bounds a wedged generation with the SPEAK watchdog (#2108). The
        // barge-in decision and its reasoning live with the adapter in
        // voice-agent-session.ts.
        say: realtimeScriptedSpeech(session, {
          observer: {
            arm: () => {
              audioLeftSinceArm = false;
              firstFrameAtSinceArm = undefined;
              callerSpokeSinceArm = false;
            },
            spoke: () => audioLeftSinceArm,
            callerSpokeSinceArm: () => callerSpokeSinceArm,
            firstFrameAt: () => firstFrameAtSinceArm,
          },
        }),
        nextFinalTranscript: async (timeoutMs) => {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const t = finals.shift();
            if (t !== undefined) return t;
            const remaining = deadline - Date.now();
            if (remaining <= 0) return null; // the watchdog's silence signal
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, remaining);
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
            wake = null;
          }
        },
      };

      // The verdict settles before anyone is spoken to (the module speaks nothing until
      // it has the category — a voicemail box gets a report and a hangup, no script).
      const verdict = await amdVerdict;
      // NO drop-stale point any more (`finals.length = 0` used to live here): every
      // queued item now carries its turn-start time, and the intake loop DROPS any turn
      // that began before question 1 was asked — which covers what AMD consumed
      // ("Hello?") AND the reply to the opening line ("yes, speaking"), a case the old
      // one-shot clear could never reach. The policy lives with the other binding rules
      // in voice-agent-session.ts, where the pins can see it.

      const report = await runIntakeCall(job, verdict.category, {
        session: seam,
        // #2157 guard: persisted NOW, per turn, in the same statement shapes the executor
        // uses — never in a shutdown callback, which the teardown race can skip entirely.
        persistAnswer: async (questionId, value) => {
          await recordAnswer(crmDb, job.touchId, questionId, value, bound);
        },
        reached: async (ordinal) => {
          await crmDb.query(`update crm.touches set reached_ordinal = $2 where id = $1`, [
            job.touchId,
            ordinal,
          ]);
        },
        // Report BEFORE hangup (pinned): the transport is polling THIS metadata.
        publishReport: async (r) => {
          await rooms.updateRoomMetadata(roomName, encodeAgentCallReport(r));
        },
        // The documented hangup: deleting the room drops the PSTN leg and this job.
        hangUp: async () => {
          await rooms.deleteRoom(roomName);
        },
      });

      console.log(
        `[voice-agent] call done room=${roomName} touch=${job.touchId} ` +
          `amd=${report.amdResult} conversation=${String(report.conversation)} ` +
          `answers=${report.answersPersisted} reached=${report.reachedOrdinal}`,
      );
    } finally {
      // Connection hygiene only — NO persistence lives here (#2157: this block may never
      // run on the teardown race, and nothing of value is lost when it doesn't).
      await crmDb.end().catch(() => {});
    }
  },
});

// Explicit dispatch ONLY: registering under LIVEKIT_AGENT_NAME means this worker joins
// nothing by itself — it answers exactly the dispatches `livekitPlaceCall` creates, which
// exist only for proposals a human approved. The name must match the executor daemon's
// LIVEKIT_AGENT_NAME or every dispatch waits forever for a worker that never claims it.
cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: required("LIVEKIT_AGENT_NAME"),
  }),
);
