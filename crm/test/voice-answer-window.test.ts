// The answer-window invariant pins (W1–W4) — the review's Finding 3b, replacing the
// original plan's separate 1a/1b:
//
//   THE UNIFIED INVARIANT: the answer-window expiry decision may only be taken after
//   the in-flight model turn finalizes, bounded by (playout estimate + absolute cap);
//   and a bound expiry must NOT count as caller silence if a turn was open.
//
// Why it exists (probe-interrupt findings E8, verified twice): on the live call the
// caller's answer committed 10.7s into the 15s window, but 3.1 withholds turnComplete
// until its playout estimate ends — so the committed answer was INVISIBLE to the loop,
// the window expired, silence was counted against a caller who had answered, and the
// next-question directive interrupted the model's own 15.5s deferral mid-playout.
// `TurnAssembler.isTurnOpen()` existed for exactly this (F4b) and was consulted
// NOWHERE outside its own tests.
//
// The seam methods are OPTIONAL on ScriptedVoiceSession: a session that lacks them
// (every V1–V11 fake, the realtime adapter) takes the pre-fix behaviour verbatim —
// these pins drive fakes that HAVE them.
//
// 🚨 CARRY-AWARE, AGE-BOUNDED (W3): `TurnAssembler.finalize` deliberately does NOT
// reset an interrupt-opened empty turn (the F4a carry), so one interrupt can leave the
// caller-turn surface open FOREVER. The extension is therefore age-bounded against the
// turn's START — a stale carry earns neither an extension nor a silence waiver, or a
// silent caller would hold every remaining window open.
import { describe, it, expect } from "vitest";
import type { CallJobMetadata } from "../src/call-bridge.js";
import {
  runIntakeCall,
  ANSWER_WATCHDOG_MS,
  ANSWER_EXTENSION_CAP_MS,
  CALLER_TURN_EXTENSION_MAX_AGE_MS,
  MODEL_TURN_FINALIZE_MARGIN_MS,
  type IntakeDeps,
  type TimedTranscript,
} from "../src/voice-agent-session.js";

function makeClock(start: number) {
  let t = start;
  return { now: () => t, set: (v: number) => void (t = v) };
}

function jobWith(prompts: Array<{ id: string; questionKey: string; promptText: string }>): CallJobMetadata {
  return {
    v: 1,
    touchId: "00000000-0000-0000-0000-0000000000d4",
    contactId: "00000000-0000-0000-0000-0000000000a1",
    displayName: "Ana Reyes",
    openingLine: "Hi, may I speak with Ana Reyes?",
    prompts,
  };
}

const TWO_PROMPTS = jobWith([
  { id: "q1", questionKey: "budget", promptText: "What budget range are you working with?" },
  { id: "q2", questionKey: "timeline", promptText: "When are you hoping to move?" },
]);

const THREE_PROMPTS = jobWith([
  { id: "q1", questionKey: "budget", promptText: "What budget range are you working with?" },
  { id: "q2", questionKey: "timeline", promptText: "When are you hoping to move?" },
  { id: "q3", questionKey: "areas", promptText: "Which areas are you considering?" },
]);

/** A seam-aware fake: `answers` is a script of nextFinalTranscript behaviours, each a
 *  function that may move the clock and the seam surfaces before returning. Every say
 *  advances the clock 500ms and voices at the new reading (the V11 vacuity rule: the
 *  voiced stamp must differ from the say-call clock). */
function seamFakeDeps(opts: {
  clock: { now: () => number; set: (v: number) => void };
  answers: Array<(timeoutMs: number) => TimedTranscript | null>;
}) {
  const ops: string[] = [];
  const waits: number[] = [];
  const instrumented: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const surfaces: {
    modelTurnDeadline: number | undefined;
    callerTurnStartedAt: number | undefined;
  } = { modelTurnDeadline: undefined, callerTurnStartedAt: undefined };
  let i = 0;
  const deps: IntakeDeps = {
    session: {
      say: async (text) => {
        ops.push(`say:${text}`);
        opts.clock.set(opts.clock.now() + 500);
        return { delivered: true, voicedAt: opts.clock.now() };
      },
      nextFinalTranscript: async (timeoutMs) => {
        waits.push(timeoutMs);
        const step = opts.answers[i++];
        if (step === undefined) {
          opts.clock.set(opts.clock.now() + timeoutMs); // an honest silent wait
          return null;
        }
        return step(timeoutMs);
      },
      modelTurnDeadline: () => surfaces.modelTurnDeadline,
      callerTurnStartedAt: () => surfaces.callerTurnStartedAt,
    },
    persistAnswer: async (questionId, value) => {
      ops.push(`persist:${questionId}:${value}`);
    },
    reached: async () => {},
    publishReport: async (report) => {
      ops.push(`report:${String(report.conversation)}:${report.answersPersisted}`);
    },
    hangUp: async () => {
      ops.push("hangUp");
    },
    now: opts.clock.now,
    instrument: (event, detail) => {
      instrumented.push({ event, detail });
    },
  };
  return { deps, ops, waits, surfaces, instrumented };
}

describe("the unified answer-window invariant — expiry waits for the in-flight turn, bounded", () => {
  it("W1: a window expiring under an in-flight model turn EXTENDS to the turn's deadline (+margin) and captures the answer under the RIGHT question, before the next say", async () => {
    // The deferral case at 1:1 scale. VACUOUS IF the answer arrived inside the
    // original budget (no extension needed), or if the grant were unasserted — the
    // pre-fix loop ALSO recovers this answer later via bindTurn's backfill during the
    // NEXT window, so the ORDER (persist before the next say) and the WAIT ARITHMETIC
    // are what separate fixed from broken.
    const clock = makeClock(0);
    const h = seamFakeDeps({
      clock,
      answers: [
        (t) => {
          // q1's window: the full watchdog passes in silence — but the model's
          // auto-reply (carrying the caller's committed answer behind it) is in
          // flight, estimate end 27_000.
          clock.set(clock.now() + t); // 1_000 + 15_000 = 16_000
          h.surfaces.modelTurnDeadline = 27_000;
          return null;
        },
        () => {
          // the extension: the turn finalizes at its estimate and the answer lands
          clock.set(27_000);
          h.surfaces.modelTurnDeadline = undefined;
          return { transcript: "Around three to four million pesos.", turnStartedAt: 11_700 };
        },
        () => ({ transcript: "Early next year.", turnStartedAt: clock.now() + 1_000 }),
      ],
    });
    const report = await runIntakeCall(TWO_PROMPTS, "human", h.deps);
    // The extension's arithmetic, exact: expiry decided at 16_000 with deadline
    // 27_000 → grant = 27_000 + margin − 16_000.
    expect(h.waits[0]).toBe(ANSWER_WATCHDOG_MS);
    expect(h.waits[1]).toBe(27_000 + MODEL_TURN_FINALIZE_MARGIN_MS - 16_000);
    // The answer landed on q1 BEFORE q2 was ever spoken — not backfilled after.
    const persistIdx = h.ops.indexOf("persist:q1:Around three to four million pesos.");
    const sayQ2Idx = h.ops.indexOf("say:When are you hoping to move?");
    expect(persistIdx).toBeGreaterThan(-1);
    expect(sayQ2Idx).toBeGreaterThan(-1);
    expect(persistIdx).toBeLessThan(sayQ2Idx);
    expect(report.conversation).toBe("identity_not_asked_complete");
    // The instrumentation shipped WITH the phase (the review: without it the live
    // gate is "vibes"): the extension announced itself with the turn state.
    const ext = h.instrumented.find((e) => e.event === "answer-window-extended");
    expect(ext?.detail["modelTurnInFlight"]).toBe(true);
  });

  it("W2: a bound expiry with a model turn STILL open is not caller silence — two long auto-replies must not end the call as a dead line", async () => {
    // MAX_CONSECUTIVE_SILENCES = 2: pre-fix, two windows expiring under auto-replies
    // ended the call on a caller who answered both times. Here the model turn never
    // finalizes (deadline crawls ahead of the clock), the extension cap runs out, and
    // the loop must ADVANCE WITHOUT COUNTING SILENCE — all three questions asked.
    // VACUOUS IF the deadline cleared before the cap (that is W1's captured path).
    const clock = makeClock(0);
    const h = seamFakeDeps({
      clock,
      answers: [], // every wait is an honest silent timeout (the default step)
    });
    // The model surface: perpetually in flight, deadline always 5s ahead — the shape
    // of a server withholding turnComplete past its own estimate.
    h.surfaces.modelTurnDeadline = 5_000;
    const origNow = clock.now;
    h.deps.session.modelTurnDeadline = () => origNow() + 5_000;
    const report = await runIntakeCall(THREE_PROMPTS, "human", h.deps);
    // Every question was asked — the dead-line break never fired…
    expect(h.ops).toContain("say:Which areas are you considering?");
    // …the report stays honest (nothing was answered)…
    expect(report.conversation).toBe("identity_not_asked_cut_off");
    expect(report.answersPersisted).toBe(0);
    // …the extension total is CAPPED per window (budget beyond the watchdog never
    // exceeds the cap)…
    for (const [k, w] of h.waits.entries()) {
      expect(w, `wait #${k}`).toBeLessThanOrEqual(Math.max(ANSWER_WATCHDOG_MS, ANSWER_EXTENSION_CAP_MS));
    }
    // …and the expiry line says why no silence was counted.
    const exp = h.instrumented.find((e) => e.event === "answer-window-expiry");
    expect(exp?.detail["countedSilence"]).toBe(false);
    expect(exp?.detail["modelTurnInFlight"]).toBe(true);
  });

  it("W3: a STALE caller-turn carry (F4a) earns neither extension nor a silence waiver — the dead-line bound survives", async () => {
    // The carry hazard the review flagged: one interrupt can hold isTurnOpen() true
    // FOREVER. Age is the only clean discriminator: this stamp is far older than the
    // extension age bound, so the windows expire exactly as before the fix and two
    // silences still end the call. VACUOUS IF the stamp were recent (that is W4) —
    // and this pin REDS if the age bound is ever dropped, because the un-aged surface
    // would then suppress the silence count and q3 would be asked.
    const clock = makeClock(0);
    const h = seamFakeDeps({ clock, answers: [] });
    h.deps.session.callerTurnStartedAt = () => 100; // an ancient interrupt carry
    const report = await runIntakeCall(THREE_PROMPTS, "human", h.deps);
    // Sanity: the stamp really is stale relative to the bound at first expiry.
    expect(15_000 - 100).toBeGreaterThan(CALLER_TURN_EXTENSION_MAX_AGE_MS);
    // Two silent windows, then the dead-line break: q3 is never asked.
    expect(h.ops).toContain("say:When are you hoping to move?");
    expect(h.ops).not.toContain("say:Which areas are you considering?");
    expect(report.conversation).toBe("identity_not_asked_cut_off");
  });

  it("W4: a RECENT open caller turn extends the window, age-bounded, and the late batch lands on ITS question before the next say", async () => {
    // F4b at last consulted: fragments can land as one end-of-utterance batch ~3s
    // after speech began. The turn opened 1s before expiry, so the extension runs to
    // (turnStart + age bound); the batch lands inside it. VACUOUS IF the extension
    // arithmetic were unasserted, or if the answer carried no turn time (the ordering
    // would be undecidable).
    const clock = makeClock(0);
    const h = seamFakeDeps({
      clock,
      answers: [
        (t) => {
          clock.set(clock.now() + t); // q1's watchdog passes: 1_000 + 15_000 = 16_000
          h.surfaces.callerTurnStartedAt = 15_000; // …but a caller turn opened at 15_000
          return null;
        },
        () => {
          clock.set(18_000); // the batch lands 3s after speech began
          h.surfaces.callerTurnStartedAt = undefined;
          return { transcript: "Around four million.", turnStartedAt: 15_000 };
        },
        () => ({ transcript: "Early next year.", turnStartedAt: clock.now() + 1_000 }),
      ],
    });
    const report = await runIntakeCall(TWO_PROMPTS, "human", h.deps);
    // grant = (turnStart + age bound) − now = 15_000 + bound − 16_000
    expect(h.waits[1]).toBe(15_000 + CALLER_TURN_EXTENSION_MAX_AGE_MS - 16_000);
    const persistIdx = h.ops.indexOf("persist:q1:Around four million.");
    const sayQ2Idx = h.ops.indexOf("say:When are you hoping to move?");
    expect(persistIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeLessThan(sayQ2Idx);
    expect(report.conversation).toBe("identity_not_asked_complete");
  });
});
