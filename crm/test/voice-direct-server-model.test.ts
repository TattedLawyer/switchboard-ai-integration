// The SERVER-MODEL fixture and the live-failure reproduction (SM1–SM2) — the review's
// Finding 6, the highest-leverage item: the 2026-08-23 self-interrupt defect was
// INVISIBLE to every offline test because the fakes did not model the server's
// semantics. This fixture encodes the PROBE MEASUREMENTS (probe-interrupt findings
// E7–E11, dry socket, n=2–12) as executable behaviour:
//
//   · `turnComplete` is WITHHELD until the server's playout estimate ends:
//     turnComplete ≈ firstAudio + audioMs (n=2, ±4ms — the fixture errs 3ms late).
//   · a directive (`sendClientContent`) landing while that estimate is still running
//     emits `interrupted` ~50ms later with NO caller audio (47–134ms, n=12; 6/6 on a
//     3.1 dry socket), then the aborted turn's `turnComplete` ~2ms after. The
//     interrupting directive is ABSORBED — the live deferral call shows the next
//     voiced turn was the loop's re-ask, not a response to the interrupter.
//   · a committed caller turn triggers a model AUTO-REPLY ~100ms later (E5: the live
//     deferral began 94ms after the caller's commit — no directive involved).
//   · generation outruns playout ~3.5x (E10: mean 4.55x live, 3.3–3.7x byte-counted).
//
// SM1 then REPRODUCES THE LIVE FAILURE against the REAL intake loop + REAL channel +
// REAL assembler + REAL tracker, wired exactly as worker-direct.ts wires them: the
// caller's answer commits 10.7s into a 15s answer window, the model's 15.5s deferral
// auto-reply withholds turnComplete past the window, the window expires, the loop's
// next-question directive interrupts the model's own reply. Under the OLD composition
// that produced: a self-inflicted `interrupted` (destroying ~60% of the deferral on
// the live call), a WASTED re-ask of the next question, and — through the F4a carry
// the interrupt opens — the next answer misfiled to a stamp from the interrupt, i.e. a
// cut_off report on a caller who answered everything.
//
// VACUITY (SM1): the pin is only meaningful if the fixture actually withholds
// turnComplete and interrupts on mid-playout directives — SM2 pins the fixture itself
// against the probe numbers, so SM1 cannot go green by a fixture that resolves
// everything instantly. Deletion check (run, output in the phase report): removing the
// channel's turn-gate consult OR the loop's expiry-extension consult reds SM1.
import { describe, it, expect, vi, afterEach } from "vitest";
import type { CallJobMetadata } from "../src/call-bridge.js";
import {
  runIntakeCall,
  type IntakeDeps,
  type ScriptedVoiceSession,
  type TimedTranscript,
} from "../src/voice-agent-session.js";
import { DirectSpeechChannel } from "../src/voice-direct-speech.js";
import { TurnAssembler } from "../src/voice-direct-turns.js";
import { ModelTurnTracker, type InterruptReading } from "../src/voice-model-turn.js";
import type { DirectiveTurn } from "../src/voice-direct-events.js";

// ─── the server model — probe measurements as behaviour ───────────────────────────────

type ServerEvent =
  | { type: "audio"; durationMs: number }
  | { type: "inputTranscription"; text: string }
  | { type: "interrupted" }
  | { type: "generationComplete" }
  | { type: "turnComplete" };

/** What the scripted CALLER does after a given directive is fully voiced. Consumed
 *  once per match — a re-ask does not conjure a second caller. */
interface CallerScript {
  matchText: string;
  answerDelayMs: number;
  fragments: string[];
  autoReplyAudioMs: number;
}

class ServerModel31 {
  readonly directives: { at: number; text: string }[] = [];
  readonly interrupts: { at: number; msAfterDirective: number }[] = [];
  /** The playout-estimate end of the in-flight turn; 0 = nothing in flight. */
  private estimateEnd = 0;
  private turnTimers: ReturnType<typeof setTimeout>[] = [];
  private readonly scripts: CallerScript[];

  constructor(
    private readonly emit: (ev: ServerEvent) => void,
    scripts: CallerScript[],
    private readonly directiveAudioMs = 2_000,
  ) {
    this.scripts = [...scripts];
  }

  /** The channel host seam — one DirectiveTurn on the wire. */
  sendDirective(turn: DirectiveTurn): void {
    const text = turn.turns[0]!.parts[0]!.text;
    const at = Date.now();
    this.directives.push({ at, text });
    if (this.estimateEnd > at) {
      // E7/E11: clientContent mid-estimated-playout → `interrupted` ~50ms later, the
      // aborted turn's `turnComplete` ~2ms after that; the directive itself is
      // absorbed (see the header).
      this.abortInFlight();
      setTimeout(() => {
        this.interrupts.push({ at: Date.now(), msAfterDirective: Date.now() - at });
        this.emit({ type: "interrupted" });
        setTimeout(() => this.emit({ type: "turnComplete" }), 2);
      }, 50);
      return;
    }
    this.startModelTurn(this.directiveAudioMs, () => this.runCallerScript(text));
  }

  /** One model turn: first audio 400ms after the trigger, four audio parts across the
   *  generation wall (audioMs / 3.5 — E10), generationComplete at generation end, and
   *  turnComplete WITHHELD until firstAudio + audioMs (+3ms, the measured jitter's
   *  late edge). */
  private startModelTurn(audioMs: number, onVoiced?: () => void): void {
    const firstAudioDelay = 400;
    const genMs = Math.max(Math.round(audioMs / 3.5), 40);
    const parts = 4;
    for (let k = 0; k < parts; k += 1) {
      this.turnTimers.push(
        setTimeout(
          () => this.emit({ type: "audio", durationMs: audioMs / parts }),
          firstAudioDelay + Math.round((genMs * k) / parts),
        ),
      );
    }
    this.turnTimers.push(
      setTimeout(() => this.emit({ type: "generationComplete" }), firstAudioDelay + genMs),
    );
    this.estimateEnd = Date.now() + firstAudioDelay + audioMs;
    this.turnTimers.push(
      setTimeout(() => {
        this.estimateEnd = 0;
        this.turnTimers = [];
        this.emit({ type: "turnComplete" });
        onVoiced?.();
      }, firstAudioDelay + audioMs + 3),
    );
  }

  private abortInFlight(): void {
    for (const t of this.turnTimers) clearTimeout(t);
    this.turnTimers = [];
    this.estimateEnd = 0;
  }

  /** The caller: commits fragments (150ms apart) after their scripted delay, and the
   *  model auto-replies 100ms after the last fragment (E5). */
  private runCallerScript(voicedText: string): void {
    const idx = this.scripts.findIndex((s) => voicedText.includes(s.matchText));
    if (idx < 0) return;
    const [script] = this.scripts.splice(idx, 1);
    if (script === undefined) return;
    setTimeout(() => {
      for (const [k, frag] of script.fragments.entries()) {
        setTimeout(() => this.emit({ type: "inputTranscription", text: frag }), k * 150);
      }
      const lastFragAt = (script.fragments.length - 1) * 150;
      setTimeout(() => this.startModelTurn(script.autoReplyAudioMs), lastFragAt + 100);
    }, script.answerDelayMs);
  }
}

// ─── the composition under test — wired the way worker-direct.ts wires it ─────────────

const JOB: CallJobMetadata = {
  v: 1,
  touchId: "00000000-0000-0000-0000-0000000000d4",
  contactId: "00000000-0000-0000-0000-0000000000a1",
  displayName: "Ana Reyes",
  openingLine: "Hi, may I speak with Ana Reyes?",
  prompts: [
    { id: "q1", questionKey: "budget", promptText: "What budget range are you working with?" },
    { id: "q2", questionKey: "timeline", promptText: "When are you hoping to move?" },
  ],
};

function buildHarness(scripts: CallerScript[]) {
  const now = () => Date.now();
  const tracker = new ModelTurnTracker(now);
  const assembler = new TurnAssembler(now);
  const readings: InterruptReading[] = [];
  const finals: TimedTranscript[] = [];
  let wake: (() => void) | null = null;
  const pushFinal = (turn: TimedTranscript) => {
    finals.push(turn);
    wake?.();
  };

  // The worker's onEvent translation, verbatim in shape and ORDER (tracker before the
  // speech channel at turnComplete, so a parked say sees the gate already clear).
  const onEvent = (ev: ServerEvent): void => {
    switch (ev.type) {
      case "audio":
        speech.onAudioFrame();
        tracker.onAudioFrame(ev.durationMs);
        break;
      case "inputTranscription":
        assembler.onInputTranscription(ev.text);
        speech.onCallerFragment();
        tracker.onCallerFragment();
        break;
      case "interrupted":
        readings.push(tracker.onInterrupted());
        assembler.onInterrupted();
        speech.onInterrupted();
        break;
      case "generationComplete":
        tracker.onGenerationComplete();
        break;
      case "turnComplete": {
        tracker.onTurnComplete();
        const turn = assembler.onTurnComplete();
        if (turn !== null) pushFinal(turn);
        speech.onTurnComplete();
        break;
      }
    }
  };

  const fixture = new ServerModel31(onEvent, scripts);
  const speech = new DirectSpeechChannel(
    {
      sendDirective: (turn) => {
        tracker.onDirectiveSent();
        fixture.sendDirective(turn);
      },
    },
    { now, turnGate: { sendWaitDeadline: () => tracker.sendWaitDeadline() } },
  );

  const seam: ScriptedVoiceSession = {
    say: async (text) => {
      const straggler = assembler.onSayRearm();
      if (straggler !== null) pushFinal(straggler);
      return speech.say(text);
    },
    nextFinalTranscript: async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const turn = finals.shift();
        if (turn !== undefined) return turn;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
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
    callerTurnStartedAt: () => assembler.openTurnStartedAt(),
    modelTurnDeadline: () => tracker.sendWaitDeadline(),
  };

  const ops: string[] = [];
  const instrumented: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const deps: IntakeDeps = {
    session: seam,
    persistAnswer: async (questionId, value) => {
      ops.push(`persist:${questionId}:${value}`);
    },
    reached: async () => {},
    publishReport: async (report) => {
      ops.push(`report:${String(report.conversation)}`);
    },
    hangUp: async () => {
      ops.push("hangUp");
    },
    now,
    instrument: (event, detail) => {
      instrumented.push({ event, detail });
    },
  };
  return { fixture, deps, ops, readings, instrumented };
}

async function advanceUntil(done: () => boolean, maxVirtualMs: number): Promise<void> {
  for (let elapsed = 0; elapsed < maxVirtualMs && !done(); elapsed += 500) {
    await vi.advanceTimersByTimeAsync(500);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the server-model fixture — the live failure, reproduced and then closed", () => {
  it("SM1: an answer committing 10.7s into the window, under a 15.5s auto-reply, must NOT be expired into a self-inflicted interrupt — no interrupt, no wasted re-ask, every answer lands", async () => {
    vi.useFakeTimers({ now: 0 });
    const { fixture, deps, ops, readings, instrumented } = buildHarness([
      {
        // The live deferral shape: the caller answers Q1 at +10.7s; the model's
        // auto-reply carries 15.5s of speakable audio, so its turnComplete lands
        // ~11.6s AFTER the answer window would expire.
        matchText: "What budget range",
        answerDelayMs: 10_700,
        fragments: [" Around", " three to four", " million pesos."],
        autoReplyAudioMs: 15_500,
      },
      {
        matchText: "When are you hoping",
        answerDelayMs: 3_000,
        fragments: [" Hoping to move", " early next year."],
        autoReplyAudioMs: 1_200,
      },
    ]);

    let settled = false;
    let failure: unknown;
    const reportP = runIntakeCall(JOB, "human", deps).then(
      (r) => {
        settled = true;
        return r;
      },
      (e) => {
        settled = true;
        failure = e;
        return undefined;
      },
    );
    await advanceUntil(() => settled, 120_000);
    const report = await reportP;
    expect(failure).toBeUndefined();

    // THE PINS, each one a live-call defect:
    // 1. NO self-inflicted interrupt — the loop never fired a directive into the
    //    model's in-flight reply (the live call had 3/3, Δ47–51ms after expiry).
    expect(fixture.interrupts).toEqual([]);
    expect(readings).toEqual([]);
    // 2. NO wasted re-ask: each question's directive went out exactly once.
    const q2Directives = fixture.directives.filter((d) =>
      d.text.includes("When are you hoping"),
    );
    expect(q2Directives).toHaveLength(1);
    // 3. Both answers landed under their OWN questions, and the report is honest.
    expect(ops).toContain("persist:q1:Around three to four million pesos.");
    expect(ops).toContain("persist:q2:Hoping to move early next year.");
    expect(report?.conversation).toBe("identity_not_asked_complete");
    expect(report?.answersPersisted).toBe(2);
    // 4. The LOOP's expiry-extension consult was load-bearing, not decorative. In
    //    this scenario the channel's gate ALONE also prevents the interrupt (defense
    //    in depth — a parked directive cannot land mid-playout), so pins 1–3 cannot
    //    red on a deleted loop consult by themselves. The instrumentation can: the
    //    window must have EXTENDED under the in-flight model turn, and no expiry may
    //    ever have counted silence against this caller (the live call counted two).
    const extended = instrumented.filter((e) => e.event === "answer-window-extended");
    expect(extended.length).toBeGreaterThan(0);
    expect(extended[0]!.detail["modelTurnInFlight"]).toBe(true);
    const silentExpiries = instrumented.filter(
      (e) => e.event === "answer-window-expiry" && e.detail["countedSilence"] === true,
    );
    expect(silentExpiries).toEqual([]);
  });

  it("SM2: the fixture itself obeys the probe measurements — turnComplete withheld to firstAudio+audioMs, and a mid-playout directive interrupts ~50ms later (SM1's anti-vacuity anchor)", async () => {
    vi.useFakeTimers({ now: 0 });
    const events: { at: number; ev: ServerEvent }[] = [];
    const fixture = new ServerModel31((ev) => events.push({ at: Date.now(), ev }), [], 4_000);
    const directive: DirectiveTurn = {
      turns: [{ role: "user", parts: [{ text: "Say this now" }] }],
      turnComplete: true,
    };
    fixture.sendDirective(directive);
    await vi.advanceTimersByTimeAsync(2_000);
    // Mid-playout (estimate ends at 400 + 4000 = 4400): a second directive interrupts.
    fixture.sendDirective(directive);
    await vi.advanceTimersByTimeAsync(10_000);
    const audio = events.filter((e) => e.ev.type === "audio");
    const firstAudioAt = audio[0]!.at;
    expect(firstAudioAt).toBe(400);
    // The withheld turnComplete of the FIRST turn never fired (aborted); instead the
    // interrupt landed 50ms after the mid-playout directive, then turnComplete +2ms.
    expect(fixture.interrupts).toHaveLength(1);
    expect(fixture.interrupts[0]!.msAfterDirective).toBe(50);
    const interruptAt = fixture.interrupts[0]!.at;
    const turnCompletes = events.filter((e) => e.ev.type === "turnComplete");
    expect(turnCompletes).toHaveLength(1);
    expect(turnCompletes[0]!.at).toBe(interruptAt + 2);
    // And on an UNDISTURBED turn, turnComplete is withheld until firstAudio + audioMs.
    const fixture2Events: { at: number; ev: ServerEvent }[] = [];
    const fixture2 = new ServerModel31((ev) => fixture2Events.push({ at: Date.now(), ev }), [], 4_000);
    const t0 = Date.now();
    fixture2.sendDirective(directive);
    await vi.advanceTimersByTimeAsync(10_000);
    const tc = fixture2Events.find((e) => e.ev.type === "turnComplete");
    const fa = fixture2Events.find((e) => e.ev.type === "audio");
    expect(fa!.at - t0).toBe(400);
    expect(tc!.at - fa!.at).toBe(4_003); // audioMs + the measured jitter's late edge
    const gen = fixture2Events.find((e) => e.ev.type === "generationComplete");
    expect(gen!.at - fa!.at).toBeLessThan(1_500); // generation outran playout ~3.5x
  });
});
