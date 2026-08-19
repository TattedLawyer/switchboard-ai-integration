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
//   #2108 400-after-barge-in loops and the agent goes silent -> every scripted utterance
//         is `allowInterruptions: false` (in `say` below) and the per-turn WATCHDOG in
//         `voice-agent-session.ts` bounds any silent wedge to one advance-or-end window.
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
// FIRST-LIVE-CALL TUNING (needs real audio + credentials, cannot be decided from here):
// Q/A alignment for eager speakers — a callee who answers DURING a question, or whose
// "yes, speaking" after the opening line lands while question 1 is playing, can have an
// utterance attributed to the wrong question. The transcript queue below keeps everything
// final; the drop-stale point (before the opening line) discards only what AMD consumed.
// Tune on the first real calls; the session seam is where any policy change goes.
import { fileURLToPath } from "node:url";
import pg from "pg";
import { RoomServiceClient } from "livekit-server-sdk";
import { type JobContext, WorkerOptions, cli, defineAgent, voice } from "@livekit/agents";
import * as google from "@livekit/agents-plugin-google";
import {
  encodeAgentCallReport,
  parseCallJobMetadata,
} from "../crm/src/call-bridge.js";
import {
  runIntakeCall,
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
        }),
        // #2059 guard: never preemptive. Explicit, not defaulted, so a library that
        // flips the default cannot flip us.
        preemptiveGeneration: false,
      });

      // AMD FIRST — constructed and started before the SIP participant can exist (the
      // transport dispatches this agent BEFORE dialling, and AMD's own SIP gate waits for
      // call-active so ringback never burns the budget). `interruptOnMachine: false`: the
      // script never speaks before the verdict, so there is nothing to interrupt, and the
      // hangup is OURS (report first, then deleteRoom), never the library's.
      const amd = new voice.AMD(session, { interruptOnMachine: false });
      const amdVerdict = amd.execute();

      // FINAL transcripts only, queued in arrival order. The intake consumes one per
      // question; `voice-agent-session.ts` owns the watchdog and every decision.
      const finals: string[] = [];
      let wake: (() => void) | null = null;
      session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
        if (ev.isFinal && ev.transcript.trim() !== "") {
          finals.push(ev.transcript);
          wake?.();
        }
      });

      await session.start({
        // ZERO TOOLS (#2249) — an empty Agent: no tools defined, no toolChoice sent.
        agent: new voice.Agent({
          instructions:
            "You are placing a scripted intake call. Speak only the exact scripted " +
            "utterances you are given, one at a time. Never improvise, never add " +
            "questions, never claim to act on anything.",
        }),
        room: ctx.room,
        // #1248 guard: the session's own output is the ONLY audio track this process
        // publishes — no background audio, no filler, nothing else is started.
      });

      const seam: ScriptedVoiceSession = {
        say: async (text) => {
          // #2108 guard: non-interruptible; #2059 guard: awaited to playout, one at a time.
          const handle = session.say(text, { allowInterruptions: false });
          await handle.waitForPlayout();
        },
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
      // Whatever the callee said DURING classification ("Hello?") was AMD's input, not an
      // answer to a question nobody asked yet. Drop it so question 1 cannot inherit it.
      finals.length = 0;

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
