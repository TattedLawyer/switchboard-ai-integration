// The DIRECT-SOCKET agent worker — `worker.ts`'s successor, and still a COMPOSITION
// ROOT: outside every tsconfig (typechecked deliberately by hand — see the repo's
// verification gates), allowed to read env and cross workspaces by relative import,
// and PLUMBING ONLY. Every decidable behaviour lives in typechecked, pinned crm
// modules: the wire grammar and connect config in `voice-direct-events.ts`, caller-turn
// assembly in `voice-direct-turns.ts`, speech delivery in `voice-direct-speech.ts`, the
// pre-verdict audio gate in `voice-direct-gates.ts`, the two live-bought audio lessons
// in `voice-direct-pcm.ts`, and the intake loop itself — unchanged — in
// `voice-agent-session.ts`. This file only translates between the vendor's objects and
// those modules' structural seams.
//
// WHY THIS WORKER EXISTS (the migration's whole argument): on the plugin path the
// library sat between us and Gemini Live and we spent the year bounding its defects —
// #2249 (tool round-trip wedges the mic: we shipped ZERO tools), #2108 (post-barge-in
// 400 loop: bounded by watchdogs), #6224 (playout resolve proves nothing: the observer
// seam), the role-of-injections prompt leak (the model read the plugin's wrapper text
// aloud to a caller), and the instruction-duplication reconnect churn. On the raw
// socket every one of those disappears or becomes OUR code: the winning proof call
// (PROOF-direct-socket-all4-passed.log) ran both audio directions, a mid-call tool
// round-trip with a SURVIVING mic, and user-role injections that were never recited.
// This worker is that call's plumbing, production-shaped, driving the REAL intake loop.
//
// WHO TALKS TO WHOM — unchanged from worker.ts: `livekitPlaceCall` (executor daemon)
// dispatches an agent BY NAME into a per-call room with the job metadata, THEN dials
// the SIP participant into the same room. This worker parses the metadata (loudly — a
// foreign or empty job is refused, call-bridge.ts), publishes exactly ONE audio track,
// opens its OWN Gemini Live socket, gates everything on the ANSWER, runs AMD, runs the
// scripted intake with per-turn persistence into `crm.answers`, publishes the raw
// report as room metadata, and hangs up by DELETING THE ROOM.
//
// 🔴 REGISTRATION — A NEW NAME, NOT A POOL (cold-review catch, load-bearing): dispatch
// is by agent name (call-transport.ts:299-301), and worker.ts registers under
// LIVEKIT_AGENT_NAME (worker.ts:374; the executor composes with the same var,
// executor-loop.ts:170). Registering THIS worker under the same name would form a
// worker POOL: LiveKit load-balances dispatches across registered workers of a name,
// so a stale plugin worker left running would silently claim a share of production
// calls with nothing at dispatch distinguishing the implementations. This worker
// therefore reads LIVEKIT_AGENT_NAME_DIRECT (falling back to
// `${LIVEKIT_AGENT_NAME}-direct`). Cutover = pointing the executor's
// LIVEKIT_AGENT_NAME at this worker's name; rollback = pointing it back. worker.ts
// stays runnable and untouched — it IS the rollback.
//
// DISCIPLINES CARRIED OVER VERBATIM (each named for the live call or issue that bought
// it; issue numbers are livekit/agents-js even though the plugin is gone — the
// underlying hazards are transport-level and remain):
//   #1248 outbound-SIP audio death correlates with a SECOND audio track -> exactly ONE
//         track is published here: the AudioSource below, nothing else, ever.
//   #2157 teardown races skip shutdown callbacks -> nothing of value happens at
//         shutdown: answers persist per turn, the report publishes BEFORE the hangup.
//   The answer gate: AMD runs only once `sip.callStatus === 'active'` — never against
//         ringback (`awaitCallAnswered`, voice-agent-session.ts; the 2026-08-21 call).
//   Honest death: a mid-call failure publishes NO report and fabricates NOTHING — the
//         hangup guard inside `runIntakeCall` releases the line, the error propagates,
//         and the proposal stays visibly `executing` for reconcile.
//
// 🪦 TOMBSTONE — the instruction-duplication hack is DEAD. worker.ts had to pass
// INTAKE_INSTRUCTIONS twice (RealtimeModel constructor AND the Agent) because the
// plugin's activity start pushed the Agent's instructions through updateInstructions,
// which reconnected the session when they mismatched (0.479s of churn on the
// 2026-08-21 live log; the 40-line comment at worker.ts:133-151 tells the story). On
// the raw socket there is no Agent, no activity, and no second copy: ONE
// `systemInstruction` in the connect config, sent once, at connect.
//
// MODEL: pinned, same constant as worker.ts. The 1007 socket-kill family (proven in
// AgenticYap's repro suite and re-proven on the spike): a model-role client turn on
// 3.1 models, odd-byte audio, mis-sized context compression, model-name mismatches,
// and the speech-config language field. The last one is UNREPRESENTABLE here —
// `DirectSpeechConfig` (voice-direct-events.ts) has no field that could carry it, and
// this file builds its config ONLY through `buildDirectConnectConfig`. No
// contextWindowCompression: a bounded intake call gains nothing, and mis-sized it is
// another 1007. NO TOOLS THIS STEP: `voice-direct-knowledge.ts` is built and proven
// (the P3 mic-survival call) but wiring it is a later step — the connect config
// carries no tool declarations, so a toolCalls event below is a loud anomaly.
import { EventEmitter } from "node:events";
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
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  type RemoteTrack,
  type Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";
import {
  EndSensitivity,
  GoogleGenAI,
  Modality,
  type LiveServerMessage,
  type Session,
} from "@google/genai";
import {
  CALLEE_PARTICIPANT_IDENTITY,
  encodeAgentCallReport,
  mapAmdCategory,
  parseCallJobMetadata,
} from "../crm/src/call-bridge.js";
import {
  INTAKE_INSTRUCTIONS,
  SIP_CALL_STATUS_ACTIVE,
  SIP_CALL_STATUS_ATTRIBUTE,
  awaitCallAnswered,
  calleeAmdOptions,
  runIntakeCall,
  type ScriptedVoiceSession,
  type TimedTranscript,
} from "../crm/src/voice-agent-session.js";
import { recordAnswer } from "../crm/src/answers.js";
import {
  buildDirectConnectConfig,
  type DirectAutomaticActivityDetection,
  type DirectInboundEvent,
} from "../crm/src/voice-direct-events.js";
import { TurnAssembler } from "../crm/src/voice-direct-turns.js";
import { ModelTurnTracker } from "../crm/src/voice-model-turn.js";
import { InventionMonitor } from "../crm/src/voice-invention.js";
import { DirectSpeechChannel } from "../crm/src/voice-direct-speech.js";
import { PreVerdictGate } from "../crm/src/voice-direct-gates.js";
import { SerialQueue, ownedPcm16FromBase64 } from "../crm/src/voice-direct-pcm.js";
import { AudioEnergyMeter } from "../crm/src/voice-audio-energy.js";
import {
  accumulateUsage,
  priceCall,
  RATE_CARD_2_5_NATIVE_AUDIO,
  RATE_CARD_3_1_FLASH_LIVE,
  type UsageSample,
} from "../crm/src/voice-usage-cost.js";

/** Pinned — the same constant worker.ts pins. NOT a 3.1 model (a model-role turn on
 *  3.1 is a session-killing 1007; and nothing here sends one anyway — the wire grammar
 *  types the role as the literal "user"). */
const VOICE_MODEL = process.env.VOICE_MODEL ?? "gemini-2.5-flash-native-audio-preview-12-2025";

/** Telephony VAD tuning, 3.1 ONLY — the measured fix for the telephony commit hang.
 *
 *  MEASURED (probe-asr, band-limited 8kHz-shaped speech at −12dB over a −45dBFS noise
 *  floor, deterministic 2/2 runs): 3.1's default detector took ~9.8s to commit a caller
 *  turn vs ~1.8s on clean 16kHz audio. On a live call that starved the intake loop —
 *  the ~15s answer watchdog fired while the commit was still pending, its next-question
 *  directive absorbed the uncommitted answer, and the call died after 2 answers. With
 *  these two fields the same stimulus commits in ~1.8s (run-teltuned31.log), and 3.1
 *  ACCEPTS the block (no 1007).
 *
 *  🚨 `automaticActivityDetection` with the SDK's `disabled` field is an INSTANT 1007
 *  socket kill on 3.1 (probe31 log-e-activity.log) — the mirror type has no slot for
 *  it, so writing it here is a compile error, not a review catch.
 *
 *  WHY 2.5 IS EXCLUDED: 2.5 commits in 2-4s on the same telephony leg today and is the
 *  known-good fallback — its turn detection is deliberately untouched (the gate below
 *  keys on the model id exactly like the call-cost rate-card selection). */
const TELEPHONY_VAD_3_1: DirectAutomaticActivityDetection = {
  endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
  silenceDurationMs: 500,
};

/** Gemini Live's audio contract, AgenticYap-verified and spike-proven: PCM16 mono,
 *  16 kHz up, 24 kHz down. The FFI resamples natively on both legs (AudioStream takes a
 *  target rate; AudioSource(24000) hands the 24k->Opus48k step to rtc-node), so no JS
 *  resampler exists in this process. */
const GEMINI_IN_RATE = 16000;
const GEMINI_OUT_RATE = 24000;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

// ─── the AMD host — a stand-in session, not an AgentSession ───────────────────────────
// The installed `voice.AMD` (1.6.4, dist/voice/amd.js) is hosted here against a minimal
// stand-in, exactly the way its own tests host it against a plain EventEmitter. The
// surface below is the VERIFIED set of touches AMD makes on its session (each cites the
// installed dist/voice/amd.js):
//   · EventEmitter          — subscribe()/cleanup() attach the session 'close' listener
//                             (amd.js:310, :490). Nothing here ever emits it; AMD's run
//                             is bounded by its own detection budget instead.
//   · pauseReplyAuthorization / resumeReplyAuthorization — called BARE, not
//                             optional-chained (amd.js:233, :252), so they MUST exist.
//                             They are no-ops here ON PURPOSE: pausing playback is the
//                             plugin-path mechanism (hold the last hop, hope nothing
//                             leaks); this stack's voicemail protection is
//                             `PreVerdictGate`, which is STRICTLY STRONGER — pre-verdict
//                             the model receives no caller audio at all and may be sent
//                             no directive, so it cannot speak to an answering machine
//                             even in principle (voice-direct-gates.ts header).
//   · _subscribeAudioStream — the AMD-owned STT pump polls it ~every 100ms until truthy
//                             (amd.js:362, in runSTTPump), then reads AudioFrames off
//                             its getReader(). The tee below is that stream: the SAME
//                             16 kHz callee audio the model is being protected from,
//                             fed from the one input pump.
//   · _roomIO               — ABSENT here, deliberately: gateListening() falls back to
//                             listening immediately when there is no roomIO
//                             (amd.js:422-427 and its docstring), which is CORRECT
//                             because execute() is only called after `awaitCallAnswered`
//                             — the answer gate this repo already owns — so "immediately"
//                             is post-answer, never ringback.
//   · interrupt             — reached ONLY on a machine verdict with interruptOnMachine
//                             set (amd.js:568-570). `calleeAmdOptions()` pins it FALSE
//                             (and the Step-0 gates test pins the pin), so this must be
//                             unreachable; the stand-in throws with the explanation
//                             rather than no-op'ing, because a silent no-op would mask a
//                             future option drift that the runtime check below also
//                             refuses.
//   · _activity, _setAmd, _onAmdPrediction, rootSpanContext, llm — all read through
//                             optional chains or only on paths this config never takes
//                             (amd.js:143, :154, :578, :259; resolveLLM touches
//                             session.llm only when Cloud Inference auto-select fails —
//                             the same LiveKit Cloud requirement the plugin path had).

/** A single-reader async FIFO of AudioFrames — the tee AMD's STT pump consumes. Pure
 *  byte-moving plumbing: no policy lives here (what may be heard is `PreVerdictGate`'s
 *  and the arming flag's decision at the push site). Unbounded on purpose: it is fed
 *  only between AMD arm and verdict (~seconds, bounded by AMD_DETECTION_TIMEOUT_MS)
 *  and AMD's pump drains it synchronously per frame. */
class AmdAudioTee {
  private queue: AudioFrame[] = [];
  private waiter: ((r: { done: boolean; value?: AudioFrame }) => void) | null = null;
  private closed = false;

  push(frame: AudioFrame): void {
    if (this.closed) return;
    if (this.waiter !== null) {
      const w = this.waiter;
      this.waiter = null;
      w({ done: false, value: frame });
      return;
    }
    this.queue.push(frame);
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
    if (this.waiter !== null) {
      const w = this.waiter;
      this.waiter = null;
      w({ done: true });
    }
  }

  /** The sliver of the ReadableStream reader contract AMD's pump actually uses:
   *  read() in a loop, cancel() in its finally (amd.js runSTTPump sendPump). */
  getReader(): {
    read(): Promise<{ done: boolean; value?: AudioFrame }>;
    cancel(): Promise<void>;
  } {
    return {
      read: async () => {
        const queued = this.queue.shift();
        if (queued !== undefined) return { done: false, value: queued };
        if (this.closed) return { done: true };
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
      cancel: async () => {
        this.close();
      },
    };
  }
}

class DirectAmdSessionHost extends EventEmitter {
  constructor(private readonly tee: AmdAudioTee) {
    super();
  }

  /** Bare-called by AMD (amd.js:233/:252) — must exist. No-ops: the voicemail
   *  protection here is `PreVerdictGate` (structurally stronger — see the host header),
   *  not playback pausing, and there is no playback pipeline to pause anyway. */
  pauseReplyAuthorization(): void {}
  resumeReplyAuthorization(): void {}

  /** AMD's STT pump polls this until truthy (amd.js:362). Always truthy here; frames
   *  only flow once the worker arms the tee post-answer. */
  _subscribeAudioStream(): AmdAudioTee {
    return this.tee;
  }

  /** Unreachable by configuration: `calleeAmdOptions()` pins interruptOnMachine false
   *  (the hangup is OURS — report first, then deleteRoom, never the library's), and the
   *  worker refuses to construct AMD otherwise. Throwing beats a no-op: if a drift ever
   *  gets this called, the call must die loudly, not half-run a library takeover. */
  interrupt(): never {
    throw new Error(
      "AMD called session.interrupt(): interruptOnMachine must be pinned false " +
        "(calleeAmdOptions, voice-agent-session.ts) — the machine path is report-then-" +
        "deleteRoom, owned by runIntakeCall, never a library-driven interrupt",
    );
  }
}

// ─── the socket translation — LiveServerMessage -> the Step-0 wire grammar ────────────

/** A pure projection of the vendor message onto `DirectInboundEvent` — the exact fields
 *  the winning call exercised, in the spike's handling order (PROOF-spike.ts
 *  handleMessage). `interimInputTranscription` is deliberately NOT translated: it was
 *  the spike's diagnostic instrument, and nothing decidable may key off interim text
 *  the final transcription can contradict (voice-direct-events.ts header). */
function translateServerMessage(msg: LiveServerMessage): DirectInboundEvent[] {
  const events: DirectInboundEvent[] = [];
  const sc = msg.serverContent;
  if (sc?.modelTurn?.parts !== undefined) {
    for (const part of sc.modelTurn.parts) {
      const b64 = part.inlineData?.data;
      if (b64 !== undefined && b64 !== "") events.push({ type: "audio", base64Pcm16: b64 });
    }
  }
  if (sc?.inputTranscription?.text) {
    events.push({ type: "inputTranscription", text: sc.inputTranscription.text });
  }
  if (sc?.outputTranscription?.text) {
    events.push({ type: "outputTranscription", text: sc.outputTranscription.text });
  }
  if (sc?.interrupted) events.push({ type: "interrupted" });
  if (sc?.generationComplete) events.push({ type: "generationComplete" });
  if (sc?.turnComplete) events.push({ type: "turnComplete" });
  if (msg.toolCall?.functionCalls?.length) {
    events.push({
      type: "toolCalls",
      calls: msg.toolCall.functionCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
    });
  }
  if (msg.goAway !== undefined) events.push({ type: "goAway" });
  if (msg.usageMetadata !== undefined) {
    events.push({
      type: "usage",
      promptTokens: msg.usageMetadata.promptTokenCount,
      responseTokens: msg.usageMetadata.responseTokenCount,
      totalTokens: msg.usageMetadata.totalTokenCount,
      thoughtsTokens: msg.usageMetadata.thoughtsTokenCount,
      promptByModality: modalitySplit(msg.usageMetadata.promptTokensDetails),
      responseByModality: modalitySplit(msg.usageMetadata.responseTokensDetails),
    });
  }
  return events;
}

/** Flatten the wire's `ModalityTokenCount[]` into `{ AUDIO: n, TEXT: n }`. Live prices
 *  audio and text ~6x apart, so discarding this split makes a call unpriceable — the
 *  reason this exists at all (see crm/src/voice-usage-cost.ts). */
function modalitySplit(
  details: { modality?: string; tokenCount?: number }[] | undefined,
): Record<string, number> | undefined {
  if (details === undefined || details.length === 0) return undefined;
  const out: Record<string, number> = {};
  for (const d of details) {
    // An unnamed modality is still billed; bucket it loudly rather than dropping it.
    const key = d.modality ?? "MODALITY_UNSPECIFIED";
    out[key] = (out[key] ?? 0) + (d.tokenCount ?? 0);
  }
  return out;
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    // LOUD OR NOT AT ALL: an empty or foreign job is refused before anything joins the
    // call (`ctx.job.metadata` is a plain string and may legitimately be empty).
    const job = parseCallJobMetadata(ctx.job.metadata);
    const bound = job.prompts.map((p) => p.id);

    // The same two credentials the executor daemon composes with: the CRM role for
    // per-turn persistence, LiveKit for the report + hangup. Env reads are legal HERE
    // and only here — this file is a composition root.
    const crmDb = new pg.Pool({ connectionString: required("CRM_DATABASE_URL") });
    const rooms = new RoomServiceClient(
      required("LIVEKIT_URL").replace(/^wss:\/\//, "https://"),
      required("LIVEKIT_API_KEY"),
      required("LIVEKIT_API_SECRET"),
    );
    const modelApiKey = required("CALL_MODEL_API_KEY");

    let gemini: Session | undefined;
    try {
      await ctx.connect();
      const roomName = ctx.room.name ?? `call-${job.touchId}`;
      const t0 = Date.now();
      const log = (tag: string, detail?: unknown) => {
        console.log(
          `[voice-agent-direct] +${Date.now() - t0}ms room=${roomName} [${tag}]` +
            (detail === undefined ? "" : " " + JSON.stringify(detail)),
        );
      };

      // ─── audio out: the ONE published track (#1248) ────────────────────────────────
      // AudioSource(24000) matches Gemini's output rate; the FFI owns 24k->Opus48k.
      // Frames are decoded into OWNED memory (never a view over Node's shared Buffer
      // pool — the interference bug of spike call #2) and captured strictly one at a
      // time (the InvalidState kill of spike call #1). Both lessons live, pinned, in
      // voice-direct-pcm.ts; this is only their wiring.
      const source = new AudioSource(GEMINI_OUT_RATE, 1);
      const outQueue = new SerialQueue((err) => {
        // Counted AND reported: a dead output path must climb in the logs, never be
        // unexplained silence (voice-direct-pcm.ts LESSON 2).
        log("capture-err", { errors: outQueue.errorCount(), err: String(err) });
      });
      let firstFrameOutAt: number | undefined;

      // ─── the decidable state machines (all crm-side, all pinned) ──────────────────
      const gate = new PreVerdictGate();
      // Date.now here is correct, not merely convenient: the assembler's turn stamps
      // and the speech channel's voicedAt must be readings of the SAME clock, because
      // runIntakeCall's binding table compares them (voice-direct-speech.ts header).
      const assembler = new TurnAssembler(() => Date.now());
      // The in-flight MODEL-turn accountant (voice-model-turn.ts): per-turn audio
      // arithmetic feeding the send gate, the intake loop's unified expiry
      // invariant, and the interrupt-classification log lines — REPORTING ONLY
      // this phase (its header): nothing it returns changes flush or settle
      // behaviour. Same Date.now as the assembler and the speech channel: one
      // clock, compared only against itself.
      const modelTurns = new ModelTurnTracker(() => Date.now());
      // The invention net (voice-invention.ts): joins each model turn's output
      // transcription, classifies it against the tracker's directive attribution and
      // the open approved question, and counts SUSPECTED INVENTIONS for the call-done
      // line. 2026-08-24 live call: unapproved credit-score and fabricated-address
      // questions rode AUTO-REPLIES. 🚨 DETECTION AND LOGGING ONLY (pinned, WD12):
      // nothing branches on a verdict to change call behaviour — the adversarial
      // review proved that altering interrupt/turn handling without a full
      // turn-attribution state machine re-creates the 2026-08-22 leak-call corruption.
      const invention = new InventionMonitor();

      const finals: TimedTranscript[] = [];
      let wake: (() => void) | null = null;
      const pushFinal = (turn: TimedTranscript) => {
        finals.push(turn);
        wake?.();
      };

      // Every usageMetadata report this call produces, kept WITH its modality split so
      // the end-of-call cost line is arithmetic on the wire's numbers, not an estimate.
      const usageSamples: UsageSample[] = [];

      const speech = new DirectSpeechChannel({
        sendDirective: (turn) => {
          if (gemini === undefined) {
            throw new Error("directive before the Gemini socket opened — wiring bug");
          }
          if (!gate.maySendDirective()) {
            // Belt to the gate's braces: runIntakeCall only speaks after the verdict,
            // so this firing means the composition is wired wrong — die loudly rather
            // than let a directive provoke generation at an unverified line.
            throw new Error(
              "directive refused: the pre-verdict gate is not open — nothing may make " +
                "the model speak before AMD settles (voice-direct-gates.ts)",
            );
          }
          modelTurns.onDirectiveSent();
          invention.onDirective(turn.turns[0]?.parts[0]?.text ?? "");
          // Wall stamp only — the delta to any following `interrupted` is the
          // msSinceDirective field on that event's own log line.
          log("send-directive");
          void gemini.sendClientContent(turn);
        },
      },
      {
        // The model-turn gate (voice-direct-speech.ts): a say PARKS while a model
        // turn is in flight, released at the wire's finalize, bounded by the
        // tracker's estimate + absolute cap. The worker injects the tracker — this
        // wiring is the plumbing half of the 2026-08-23 self-interrupt fix.
        turnGate: { sendWaitDeadline: () => modelTurns.sendWaitDeadline() },
      });

      // ─── AMD: the installed detector against the stand-in host ────────────────────
      const amdTee = new AmdAudioTee();
      let amdArmed = false; // frames reach AMD only between arm and verdict (see pump)
      const amdOptions = calleeAmdOptions();
      if ((amdOptions.interruptOnMachine as boolean) !== false) {
        // The type already pins the literal; this is the runtime tripwire for a future
        // edit that widens it. The stand-in's interrupt() would also throw — later, on
        // a live machine verdict; this refuses at composition, before anyone's phone
        // rings.
        throw new Error(
          "calleeAmdOptions().interruptOnMachine must be false: the machine path is " +
            "report-then-deleteRoom (runIntakeCall), never a library interrupt",
        );
      }
      const amdHost = new DirectAmdSessionHost(amdTee);
      // The cast is the price of hosting AMD without an AgentSession — the surface it
      // actually touches is enumerated (and cited to amd.js) on the host class above,
      // and AMD's own tests host it the same way.
      const amd = new voice.AMD(
        amdHost as unknown as ConstructorParameters<typeof voice.AMD>[0],
        amdOptions, // VERBATIM — all four pinned decisions, voice-agent-session.ts
      );

      // ─── the Gemini Live socket — ours, at last ───────────────────────────────────
      const onEvent = (ev: DirectInboundEvent): void => {
        switch (ev.type) {
          case "audio": {
            // Feed the delivery record FIRST: voicedAt is "model audio reached the
            // output path", and the capture queue below is that path's entrance.
            speech.onAudioFrame();
            if (firstFrameOutAt === undefined) {
              firstFrameOutAt = Date.now();
              log("first-frame-out");
            }
            try {
              const int16 = ownedPcm16FromBase64(ev.base64Pcm16);
              // Per-turn accounting (the once-per-call firstFrameOutAt above is the
              // defect the tracker replaces): frame duration is sample arithmetic.
              if (modelTurns.onAudioFrame((int16.length * 1000) / GEMINI_OUT_RATE)) {
                log("model-turn-open");
              }
              const frame = new AudioFrame(int16, GEMINI_OUT_RATE, 1, int16.length);
              void outQueue.enqueue(() => source.captureFrame(frame));
            } catch (err) {
              // An odd-byte payload is upstream corruption; drop the frame loudly and
              // let the delivery watchdogs judge the turn (a dead output path shows up
              // as a climbing counter, never as unexplained silence).
              log("audio-decode-err", String(err));
            }
            break;
          }
          case "inputTranscription":
            // Caller words: turn assembly AND barge-in evidence. Content is not
            // logged — a caller's words belong in crm.answers under her grants, not in
            // process stdout.
            assembler.onInputTranscription(ev.text);
            speech.onCallerFragment();
            modelTurns.onCallerFragment(); // disqualifies the self-inflicted label
            log("transcript-in", { chars: ev.text.length });
            break;
          case "outputTranscription":
            // The AGENT's words — the delivery record. Logged in full: this is what
            // proves on a live call that only approved substance was voiced. The
            // invention net accumulates the same fragments per turn.
            invention.onOutputFragment(ev.text);
            log("transcript-out", ev.text);
            break;
          case "interrupted": {
            // The ENTIRE barge-in handler on the raw path (vs plugin #2108's 400-loop):
            // drop unplayed frames; the state machines take the event as evidence.
            const queuedDurationAtClear = source.queuedDuration; // read BEFORE the clear
            source.clearQueue();
            assembler.onInterrupted();
            // REPORTING ONLY (voice-model-turn.ts header): the reading feeds the log
            // line and nothing else — no flush policy, no settle change, this phase.
            const reading = modelTurns.onInterrupted();
            speech.onInterrupted();
            const inventionVerdict = invention.onTurnClosed(
              reading.abortedTurn?.directivePreceded ?? false,
            );
            if (inventionVerdict?.flagged === true) {
              log("SUSPECTED-INVENTION", {
                trigger: "interrupted",
                interrogatives: inventionVerdict.interrogatives,
              });
            }
            log("interrupted", {
              classification: reading.classification,
              msSinceDirective: reading.msSinceDirective,
              heardFraction:
                reading.heardFraction === undefined
                  ? undefined
                  : Number(reading.heardFraction.toFixed(3)),
              abortedTurn:
                reading.abortedTurn === undefined
                  ? undefined
                  : {
                      firstAudioAt: reading.abortedTurn.firstAudioAt,
                      audioMs: Math.round(reading.abortedTurn.audioMs),
                      audioParts: reading.abortedTurn.audioParts,
                    },
              queuedDurationAtClear,
            });
            break;
          }
          case "generationComplete":
            modelTurns.onGenerationComplete(); // the lag's left edge, stamped
            log("generation-complete"); // nothing decides on it
            break;
          case "turnComplete": {
            // Assembler BEFORE speech: a caller turn accumulated during this say must
            // be queued before the intake loop wakes to read it.
            const turn = assembler.onTurnComplete();
            if (turn !== null) pushFinal(turn);
            // Tracker BEFORE the speech channel (voice-direct-speech.ts
            // onTurnComplete header): a directive parked behind this turn is
            // released here and must find the gate already clear.
            const modelTurn = modelTurns.onTurnComplete();
            speech.onTurnComplete();
            const inventionVerdict = invention.onTurnClosed(
              modelTurn?.directivePreceded ?? false,
            );
            if (inventionVerdict?.flagged === true) {
              log("SUSPECTED-INVENTION", {
                trigger: "turn-complete",
                interrogatives: inventionVerdict.interrogatives,
              });
            }
            // generationToTurnCompleteLagMs is the number that validates (or
            // refutes) turnComplete ≈ firstAudio + audioMs on the live telephony
            // leg — currently an n=2 dry-socket estimate.
            log("turn-complete", {
              queuedCallerTurn: turn !== null,
              ...(modelTurn === undefined
                ? {}
                : {
                    firstAudioAt: modelTurn.firstAudioAt,
                    audioMs: Math.round(modelTurn.audioMs),
                    audioParts: modelTurn.audioParts,
                    directivePreceded: modelTurn.directivePreceded,
                    generationToTurnCompleteLagMs: modelTurn.generationToTurnCompleteLagMs,
                  }),
            });
            break;
          }
          case "toolCalls":
            // NO TOOLS THIS STEP: the connect config declares none, so the server has
            // nothing to call — this event is a wiring anomaly worth a loud log. The
            // knowledge layer (voice-direct-knowledge.ts, proven by P3) wires in a
            // later step.
            log("UNEXPECTED-tool-call", ev.calls.map((c) => c.name ?? "(unnamed)"));
            break;
          case "goAway":
            log("go-away"); // the server's imminent-disconnect warning
            break;
          case "usage":
            // The MODALITY SPLIT is the whole point: a bare total cannot be priced (Live
            // bills audio ~6x text). Collected for the end-of-call cost line below.
            usageSamples.push({
              promptTokens: ev.promptTokens ?? 0,
              responseTokens: ev.responseTokens ?? 0,
              totalTokens: ev.totalTokens ?? 0,
              thoughtsTokens: ev.thoughtsTokens ?? 0,
              promptByModality: ev.promptByModality ?? {},
              responseByModality: ev.responseByModality ?? {},
            });
            log("usage", {
              total: ev.totalTokens,
              prompt: ev.promptTokens,
              response: ev.responseTokens,
              thoughts: ev.thoughtsTokens,
              promptBy: ev.promptByModality,
              responseBy: ev.responseByModality,
            });
            break;
          case "closed":
            speech.onClosed(ev.code, ev.reason); // latches the channel; a pending say rejects
            log("gemini-close", { code: ev.code, reason: ev.reason || "(none)" });
            break;
          case "error":
            speech.onError(ev.message);
            log("gemini-error", { message: ev.message });
            break;
        }
      };

      // ONE config, built only through the projection that cannot carry the 1007-family
      // speech-config language field (the type has no slot for it —
      // voice-direct-events.ts). ONE copy of INTAKE_INSTRUCTIONS (see the tombstone in
      // the header). No voice name: same default voice the plugin path used. No tools.
      const connectConfig = buildDirectConnectConfig({
        systemInstruction: INTAKE_INSTRUCTIONS,
        // 3.1 ONLY — the telephony commit-hang fix (measurements and the 1007 hazard
        // on the TELEPHONY_VAD_3_1 const above). 2.5's turn detection is untouched.
        ...(VOICE_MODEL.includes("3.1") ? { automaticActivityDetection: TELEPHONY_VAD_3_1 } : {}),
      });
      // `tools` is stripped structurally, not cast: it is undefined here by
      // construction (no tools this step), and the mirror's tool grammar deliberately
      // uses the SDK enums' string VALUES rather than the nominal enums (the
      // containment rule) — the later wiring step owns that translation, at this
      // boundary, when a declaration actually exists to translate.
      const { tools: _unwiredTools, realtimeInputConfig, ...connectRest } = connectConfig;
      const ai = new GoogleGenAI({ apiKey: modelApiKey });
      let socketOpened!: () => void;
      const socketOpenP = new Promise<void>((resolve) => (socketOpened = resolve));
      gemini = await ai.live.connect({
        model: VOICE_MODEL,
        config: {
          ...connectRest,
          // The builder's "AUDIO" literal re-expressed as the SDK's enum member — the
          // same string at runtime; only the enum's nominal type differs. The spread
          // keeps the builder the single author of every other field.
          responseModalities: [Modality.AUDIO],
          // Same re-expression for the VAD sensitivity when the builder emitted the
          // block (3.1 only — see TELEPHONY_VAD_3_1): the mirror's sole legal value is
          // "END_SENSITIVITY_HIGH", so this translation is total. When the builder
          // omitted the block, NOTHING is spread — 2.5's default turn detection stays
          // byte-identical to today.
          ...(realtimeInputConfig !== undefined
            ? {
                realtimeInputConfig: {
                  automaticActivityDetection: {
                    endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
                    silenceDurationMs:
                      realtimeInputConfig.automaticActivityDetection.silenceDurationMs,
                  },
                },
              }
            : {}),
        },
        callbacks: {
          onopen: () => {
            log("gemini-open");
            socketOpened();
          },
          onmessage: (msg: LiveServerMessage) => {
            for (const event of translateServerMessage(msg)) onEvent(event);
          },
          onerror: (e) => {
            onEvent({ type: "error", message: String(e?.message ?? e) });
          },
          onclose: (e) => {
            onEvent({ type: "closed", code: e?.code ?? 0, reason: e?.reason ?? "" });
          },
        },
      });
      await socketOpenP; // the model must be ready before the callee can answer

      // ─── publish the ONE track (#1248) ────────────────────────────────────────────
      const track = LocalAudioTrack.createAudioTrack("agent_audio", source);
      await ctx.room.localParticipant?.publishTrack(
        track,
        new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
      );
      log("track-published");

      // ─── audio in: ONE pump, TEE'd ────────────────────────────────────────────────
      // AudioStream(track, {sampleRate:16000}) — the FFI resamples natively, so the
      // plugin's JS-side resampler stage does not exist here (spike step 5). Branch 1:
      // the AMD tee (armed only between answer and verdict — pushing earlier would hand
      // AMD a backlog of ringback/early-media to classify, the exact budget-burn the
      // answer gate exists to prevent). Branch 2: through PreVerdictGate to the model —
      // 🚨 the `audio:` field, never its deprecated sibling (a known 1007 cause), and
      // AMD hears exactly the audio the model is being protected from.
      const calleeTrack = await new Promise<RemoteTrack>((resolve) => {
        const fromExisting = (): RemoteTrack | undefined => {
          const room: Room = ctx.room;
          for (const participant of room.remoteParticipants.values()) {
            if (participant.identity !== CALLEE_PARTICIPANT_IDENTITY) continue;
            for (const pub of participant.trackPublications.values()) {
              const t = pub.track;
              if (t !== undefined && t.kind === TrackKind.KIND_AUDIO) return t;
            }
          }
          return undefined;
        };
        // Listener FIRST, then the existing-state check — the same no-gap ordering the
        // speech channel pins for its arm-before-send (a subscribe landing between
        // "checked" and "listening" would otherwise be lost).
        const onSubscribed = (t: RemoteTrack, _pub: unknown, participant: { identity: string }) => {
          if (participant.identity !== CALLEE_PARTICIPANT_IDENTITY) return;
          if (t.kind !== TrackKind.KIND_AUDIO) return;
          ctx.room.off(RoomEvent.TrackSubscribed, onSubscribed);
          resolve(t);
        };
        ctx.room.on(RoomEvent.TrackSubscribed, onSubscribed);
        const existing = fromExisting();
        if (existing !== undefined) {
          ctx.room.off(RoomEvent.TrackSubscribed, onSubscribed);
          resolve(existing);
        }
      });
      log("callee-track-subscribed");

      // ─── the energy meter — an INSTRUMENT on the inbound leg, never a gate ────────
      // Three post-mortems stalled on the same undecidable: was the caller SPEAKING?
      // The log carries `transcript-in` (what the MODEL returned), nothing about the
      // audio itself — and the live echo hypothesis (our own playout re-entering the
      // mic leg, phantom `interrupted`s on the dry socket) is detectable ONLY by
      // correlating inbound energy with whether OUR audio was playing, because this
      // process never sees the caller's speaker. `source.queuedDuration > 0` is that
      // playout flag: unplayed audio remains queued on the ONE published track, so our
      // voice is (about to be) on the line. Levels, counts and timestamps ONLY —
      // caller words belong in crm.answers under the broker's grants, never stdout.
      // The threshold is PROVISIONAL and env-tunable: the meter's first job is to
      // MEASURE this telephony leg so a real threshold can be chosen from data
      // (calibration section, crm/src/voice-audio-energy.ts). Observation only — a
      // barge-in gate is a separate, unapproved decision, and nothing the meter
      // returns feeds back into the pump.
      const energy = new AudioEnergyMeter({
        sampleRate: GEMINI_IN_RATE,
        ...(process.env.VOICE_ENERGY_SPEECH_RMS !== undefined &&
        process.env.VOICE_ENERGY_SPEECH_RMS !== ""
          ? { speechRmsThreshold: Number(process.env.VOICE_ENERGY_SPEECH_RMS) }
          : {}),
      });
      let energyMeterErrors = 0;

      let framesIn = 0;
      const inputPump = (async () => {
        const stream = new AudioStream(calleeTrack, {
          sampleRate: GEMINI_IN_RATE,
          numChannels: 1,
        });
        const reader = stream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done || value === undefined) break;
          if (amdArmed) amdTee.push(value);
          if (gate.offerCallerFrame(value) !== null) {
            // Int16Array frames are whole samples — the odd-byte 1007 cannot occur on
            // this leg; base64 straight off the frame's own bytes.
            const buf = Buffer.from(value.data.buffer, value.data.byteOffset, value.data.byteLength);
            gemini!.sendRealtimeInput({
              audio: { data: buf.toString("base64"), mimeType: `audio/pcm;rate=${GEMINI_IN_RATE}` },
            });
          }
          framesIn += 1;
          // The meter observes EVERY inbound frame — pre-verdict audio included (case
          // 3, "did they actually answer", needs energy from the very first frame the
          // gate is still dropping) — and it must OUTLIVE its own bugs: a meter throw
          // may never kill the pump, or the instrument affects the audio it measures.
          // First failure logs, the rest count into the summary line.
          try {
            for (const w of energy.onFrame(value.data, source.queuedDuration > 0)) {
              // Cadence: every speech-like window (the events under investigation),
              // plus every 10th window (a 3s heartbeat that keeps quiet stretches —
              // and the noise floor — visible without flooding an all-quiet call).
              if (w.speechLike || w.index % 10 === 0) {
                log("energy", {
                  w: w.index,
                  ms: w.endMs,
                  rms: Number(w.rms.toFixed(4)),
                  peak: Number(w.peak.toFixed(4)),
                  speech: w.speechLike,
                  run: w.speechRun,
                  playout: Number(w.playoutFraction.toFixed(2)),
                });
              }
            }
          } catch (err) {
            energyMeterErrors += 1;
            if (energyMeterErrors === 1) log("energy-meter-err", String(err));
          }
        }
        log("audio-in-ended", { frames: framesIn, droppedPreVerdict: gate.droppedFrameCount() });
      })();
      void inputPump.catch((err) => log("audio-in-err", String(err)));

      // ─── THE ANSWER GATE (decisions in voice-agent-session.ts) ────────────────────
      // AMD starts only once the callee's `sip.callStatus` reads 'active' — never on
      // ringback. Participant first: the attribute wait THROWS if the identity is not
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
      log("call-active");

      // AMD runs HERE — post-answer, so its detection budget times real speech. The tee
      // arms now and closes at the verdict: AMD classifies exactly the post-answer audio
      // the gate is withholding from the model, and nothing else.
      amdArmed = true;
      const verdict = await amd.execute();
      amdArmed = false;
      amdTee.close();
      gate.settle(mapAmdCategory(verdict.category));
      log("amd-verdict", {
        category: verdict.category,
        gate: mapAmdCategory(verdict.category),
        framesDroppedPreVerdict: gate.droppedFrameCount(),
      });

      // ─── the REAL intake loop — unchanged, on the new channel ─────────────────────
      const seam: ScriptedVoiceSession = {
        // Re-arm BEFORE the directive: whatever the caller said up to this hand-off
        // belongs to the window that is closing (TurnAssembler.onSayRearm — the
        // straddling-turn misfile e10a401 fixed).
        say: async (text) => {
          const straggler = assembler.onSayRearm();
          if (straggler !== null) pushFinal(straggler);
          return speech.say(text);
        },
        // The worker.ts deadline loop, verbatim: timeoutMs 0 is a pure queue read
        // (remaining <= 0 returns after one shift check) — the drain contract the
        // intake loop's re-ask path depends on.
        nextFinalTranscript: async (timeoutMs) => {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const turn = finals.shift();
            if (turn !== undefined) return turn;
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
        // The unified expiry invariant's eyes (voice-agent-session.ts): the loop may
        // only take the expiry decision after the in-flight turn finalizes, bounded —
        // the model turn via the tracker's capped estimate, the caller turn via the
        // assembler's open-turn stamp (age-bounded there).
        modelTurnDeadline: () => modelTurns.sendWaitDeadline(),
        callerTurnStartedAt: () => assembler.openTurnStartedAt(),
      };

      const report = await runIntakeCall(job, verdict.category, {
        session: seam,
        // #2157 guard: persisted NOW, per turn, in the same statement shapes the
        // executor uses — never in a shutdown callback a teardown race can skip.
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
        // The loop's window stamps (open / extended / expiry), straight to the log —
        // levels, counts and timestamps ONLY, never content. Expiry additionally
        // records the assembler's own isTurnOpen() beside the seam's view of it.
        instrument: (event, detail) =>
          log(
            event,
            event === "answer-window-expiry"
              ? { ...detail, isTurnOpen: assembler.isTurnOpen() }
              : detail,
          ),
      });

      // COST, from the wire's own numbers rather than an estimate. Both readings are
      // printed because the Live docs never say whether a usageMetadata report restates a
      // running session total or prices one turn — the two differ ~10x, and one call with
      // this line settles it by observation (crm/src/voice-usage-cost.ts).
      const usageTotals = accumulateUsage(usageSamples);
      const priced = priceCall(
        usageTotals,
        VOICE_MODEL.includes("3.1") ? RATE_CARD_3_1_FLASH_LIVE : RATE_CARD_2_5_NATIVE_AUDIO,
      );
      log("call-cost", {
        model: priced.model,
        pricingAsOf: priced.pricingAsOf,
        reports: usageTotals.sampleCount,
        monotonic: usageTotals.monotonic,
        perTurnTokens: usageTotals.perTurn.totalTokens,
        cumulativeTokens: usageTotals.cumulative.totalTokens,
        promptBy: usageTotals.perTurn.promptByModality,
        responseBy: usageTotals.perTurn.responseByModality,
        thoughts: usageTotals.perTurn.thoughtsTokens,
        usdIfPerTurn: Number(priced.perTurn.totalUsd.toFixed(6)),
        usdIfCumulative: Number(priced.cumulative.totalUsd.toFixed(6)),
        unpriced: priced.unpricedModalities,
      });

      // The instrument's verdict on the line, beside the call's outcome: enough to
      // answer "was the caller speaking" (speech vs quiet windows, runs) and "did
      // inbound energy track OUR playout" (the echo buckets) from the log alone.
      log("energy-summary", { ...energy.summary(), meterErrors: energyMeterErrors });

      log("call-done", {
        touch: job.touchId,
        amd: report.amdResult,
        conversation: String(report.conversation),
        answers: report.answersPersisted,
        reached: report.reachedOrdinal,
        captureErrors: outQueue.errorCount(),
        framesIn,
        suspectedInventions: invention.suspectedCount(),
      });
    } finally {
      // Connection hygiene only — NO persistence lives here (#2157: this block may
      // never run on a teardown race, and nothing of value is lost when it doesn't).
      // The socket close is best-effort: after a clean call it is a courtesy; after a
      // death the speech channel has already latched off the close/error event.
      try {
        gemini?.close();
      } catch {
        // a socket that cannot close is already gone
      }
      await crmDb.end().catch(() => {});
    }
  },
});

// Explicit dispatch ONLY, under the DIRECT name — never the plugin worker's name (two
// workers under one name form a pool and LiveKit splits dispatches between them with
// nothing distinguishing the implementations; see the registration section of the
// header). Cutover is the executor's env pointing at this name; rollback is pointing it
// back at worker.ts's.
const directAgentName =
  process.env.LIVEKIT_AGENT_NAME_DIRECT ??
  (process.env.LIVEKIT_AGENT_NAME !== undefined && process.env.LIVEKIT_AGENT_NAME !== ""
    ? `${process.env.LIVEKIT_AGENT_NAME}-direct`
    : undefined);
if (directAgentName === undefined) {
  throw new Error(
    "LIVEKIT_AGENT_NAME_DIRECT (or LIVEKIT_AGENT_NAME to derive `-direct` from) is required",
  );
}
if (directAgentName === process.env.LIVEKIT_AGENT_NAME) {
  // The pool hazard, refused at startup: same name = a stale plugin worker silently
  // claims a share of production calls.
  throw new Error(
    `LIVEKIT_AGENT_NAME_DIRECT must differ from LIVEKIT_AGENT_NAME ` +
      `(both are "${directAgentName}") — two workers registered under one name form a ` +
      `dispatch POOL, and a stale worker.ts would silently claim production calls`,
  );
}
cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: directAgentName,
  }),
);
