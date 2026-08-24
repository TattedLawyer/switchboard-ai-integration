// ModelTurnTracker pins (MT1–MT7) — the in-flight MODEL-turn accountant the
// 2026-08-23 self-interrupt diagnosis proved missing. Every number in these pins is a
// probe measurement, not an invention (probe-interrupt findings, E7–E11):
//   · 3.1 withholds `turnComplete` until its own playout estimate ends —
//     turnComplete ≈ firstAudio + audioMs (dry socket, n=2, ±4ms). A WAIT BOUND only:
//     erring early is safe; it is NOT validated on the live telephony leg.
//   · a `sendClientContent` landing while that estimate is still running makes 3.1
//     emit `interrupted` 47–134ms later with NO caller audio at all (n=12) — which the
//     worker then read as caller barge-in and clearQueue()d 60% of a live deferral.
//   · the worker's only audio stamp was `firstFrameOutAt`, set ONCE PER CALL
//     (worker-direct.ts) — per-turn accounting did not exist, which is why nothing
//     could compute the estimate this module now owns.
//
// VACUITY, per pin, stated inline. The module is PURE (injected clock, no vendor
// imports — the crm containment rule) so every pin drives it directly.
import { describe, it, expect } from "vitest";
import {
  ModelTurnTracker,
  MODEL_TURN_ABSOLUTE_CAP_MS,
  SELF_INFLICTED_INTERRUPT_WINDOW_MS,
} from "../src/voice-model-turn.js";

function makeClock(start: number) {
  let t = start;
  return { now: () => t, set: (v: number) => void (t = v) };
}

describe("ModelTurnTracker — per-turn playout accounting, capped deadlines, interrupt attribution", () => {
  it("MT1: a turn opens at the FIRST audio after a turnComplete, accumulates audioMs, and RESETS per turn — never the once-per-call stamp", () => {
    // VACUOUS IF the clock did not move between the two turns: a once-per-call
    // firstAudioAt (the worker's current defect) would produce the same deadline. The
    // second turn's deadline here is derivable ONLY from a per-turn reset.
    const clock = makeClock(1_000);
    const t = new ModelTurnTracker(clock.now);
    expect(t.isTurnInFlight()).toBe(false);
    expect(t.onAudioFrame(600)).toBe(true); // opened
    clock.set(1_600);
    expect(t.onAudioFrame(400)).toBe(false); // accumulated, not re-opened
    expect(t.isTurnInFlight()).toBe(true);
    expect(t.sendWaitDeadline()).toBe(1_000 + 1_000); // firstAudioAt + audioMs
    clock.set(2_004);
    const summary = t.onTurnComplete();
    expect(summary).toMatchObject({ firstAudioAt: 1_000, audioMs: 1_000, audioParts: 2 });
    expect(t.isTurnInFlight()).toBe(false);
    // The SECOND turn: fresh stamp, fresh accumulation.
    clock.set(5_000);
    expect(t.onAudioFrame(500)).toBe(true);
    expect(t.sendWaitDeadline()).toBe(5_000 + 500); // NOT 1_000 + anything
  });

  it("MT2: the deadline is capped absolutely — a turn cannot demand an unbounded wait", () => {
    // The cap is the invariant's bound: "bounded by (playout estimate + absolute cap)".
    // VACUOUS IF audioMs stayed under the cap — feed more audio than the cap allows.
    const clock = makeClock(1_000);
    const t = new ModelTurnTracker(clock.now);
    t.onAudioFrame(30_000); // more speakable audio than the cap permits waiting for
    expect(t.sendWaitDeadline()).toBe(1_000 + MODEL_TURN_ABSOLUTE_CAP_MS);
    const t2 = new ModelTurnTracker(clock.now, { capMs: 2_000 });
    t2.onAudioFrame(30_000);
    expect(t2.sendWaitDeadline()).toBe(1_000 + 2_000);
  });

  it("MT3: no turn in flight — every query says so honestly", () => {
    // VACUOUS IF only the fresh state were checked: the post-turnComplete state is the
    // one the say() gate consults on the hot path.
    const clock = makeClock(1_000);
    const t = new ModelTurnTracker(clock.now);
    expect(t.sendWaitDeadline()).toBeUndefined();
    expect(t.heardFraction()).toBeUndefined();
    t.onAudioFrame(500);
    clock.set(1_500);
    t.onTurnComplete();
    expect(t.sendWaitDeadline()).toBeUndefined();
    expect(t.heardFraction()).toBeUndefined();
  });

  it("MT4: heard-fraction is elapsed-since-first-audio over audioMs, clamped to 1", () => {
    // The number the flush phase (LATER, unapproved) will be designed against — this
    // phase it is REPORTING only. VACUOUS IF now equalled firstAudioAt (0/anything) or
    // exceeded the estimate (clamp hides the ratio) — both regions asserted.
    const clock = makeClock(1_000);
    const t = new ModelTurnTracker(clock.now);
    t.onAudioFrame(10_000);
    clock.set(3_500);
    expect(t.heardFraction()).toBeCloseTo(0.25, 5);
    clock.set(20_000);
    expect(t.heardFraction()).toBe(1);
  });

  it("MT5: an interrupted within the self-inflicted window of our own directive, with no caller evidence since the send, is SELF_INFLICTED — and closes the turn", () => {
    // The live call's 3/3 signature: Δ 47–51ms after our send, no caller evidence.
    // Classification is LOGGING/REPORTING ONLY this phase — these pins hold the
    // reading, not any behaviour change. VACUOUS IF the directive were never recorded
    // (msSinceDirective undefined classifies candidate) — MT6c pins that path apart.
    const clock = makeClock(10_000);
    const t = new ModelTurnTracker(clock.now);
    t.onAudioFrame(15_500); // the deferral-shaped in-flight turn
    t.onDirectiveSent();
    clock.set(10_050);
    const reading = t.onInterrupted();
    expect(reading.classification).toBe("self_inflicted");
    expect(reading.msSinceDirective).toBe(50);
    expect(reading.abortedTurn).toMatchObject({ firstAudioAt: 10_000, audioMs: 15_500 });
    expect(reading.heardFraction).toBeCloseTo(50 / 15_500, 5);
    expect(t.isTurnInFlight()).toBe(false); // the server aborted the turn
  });

  it("MT6: outside the window, after caller evidence, or with no directive at all — CANDIDATE_CALLER", () => {
    // The window is 300ms = >2x the measured 47–134ms self-inflicted latency (n=12).
    // VACUOUS IF only one branch were driven: each of the three escape routes is a
    // distinct line in the classifier and each is exercised.
    const clock = makeClock(10_000);
    // (a) too late after the send
    const a = new ModelTurnTracker(clock.now);
    a.onDirectiveSent();
    clock.set(10_000 + SELF_INFLICTED_INTERRUPT_WINDOW_MS + 1);
    expect(a.onInterrupted().classification).toBe("candidate_caller");
    // (b) caller evidence AFTER the send — the caller is demonstrably in the exchange
    clock.set(20_000);
    const b = new ModelTurnTracker(clock.now);
    b.onDirectiveSent();
    clock.set(20_020);
    b.onCallerFragment();
    clock.set(20_050);
    expect(b.onInterrupted().classification).toBe("candidate_caller");
    // (b2) …but evidence from BEFORE the send does not rescue the classification
    clock.set(30_000);
    const b2 = new ModelTurnTracker(clock.now);
    b2.onCallerFragment();
    clock.set(30_500);
    b2.onDirectiveSent();
    clock.set(30_550);
    expect(b2.onInterrupted().classification).toBe("self_inflicted");
    // (c) no directive ever sent
    clock.set(40_000);
    const c = new ModelTurnTracker(clock.now);
    const reading = c.onInterrupted();
    expect(reading.classification).toBe("candidate_caller");
    expect(reading.msSinceDirective).toBeUndefined();
  });

  it("MT7: the summary carries the generationComplete→turnComplete lag — the number that validates the estimate model on the live leg", () => {
    // The probe measured turnComplete ≈ firstAudio + audioMs on a DRY socket only; the
    // review's instrumentation mandate is this lag, logged per turn, so the live
    // telephony leg can confirm or refute the estimate. VACUOUS IF generationComplete
    // and turnComplete landed at the same clock reading.
    const clock = makeClock(1_000);
    const t = new ModelTurnTracker(clock.now);
    t.onAudioFrame(16_000);
    clock.set(4_000);
    t.onGenerationComplete(); // generation outruns playout ~3.5–4.5x (E10)
    clock.set(17_000);
    const summary = t.onTurnComplete();
    expect(summary?.generationToTurnCompleteLagMs).toBe(13_000);
    // A turn that never saw generationComplete reports the lag as undefined, not 0.
    clock.set(20_000);
    t.onAudioFrame(500);
    clock.set(20_500);
    expect(t.onTurnComplete()?.generationToTurnCompleteLagMs).toBeUndefined();
  });
});

describe("MT8: directive attribution — was this turn OURS or the model's own? (the invention-detection seam)", () => {
  // 2026-08-24 live call (touch 2f7ecfae): every invented question arrived in an
  // AUTO-REPLY — a model turn with NO directive since the previous turn closed. The
  // tracker already holds both clocks (lastDirectiveSentAt, the turn's firstAudioAt);
  // these pins make the attribution a per-turn fact on the summary so the detector
  // (voice-invention.ts) never re-derives it from a second seam.
  it("MT8a: a turn whose first audio follows OUR directive reports directivePreceded: true", () => {
    // VACUOUS IF directivePreceded were hardcoded true — MT8b red-teams the inverse.
    const clock = makeClock(1_000);
    const t = new ModelTurnTracker(clock.now);
    t.onDirectiveSent();
    clock.set(1_500);
    t.onAudioFrame(800);
    clock.set(2_300);
    expect(t.onTurnComplete()).toMatchObject({ directivePreceded: true });
  });

  it("MT8b: an AUTO-REPLY — a turn opening with no directive since the last turn closed — reports directivePreceded: false", () => {
    // THE LIVE-CALL SHAPE: directive → scripted turn → caller speaks → auto-reply.
    // VACUOUS IF the tracker only checked `lastDirectiveSentAt !== undefined` (the
    // once-per-call reading): the directive HERE was sent, consumed by turn 1, and
    // must not solicit turn 2.
    const clock = makeClock(1_000);
    const t = new ModelTurnTracker(clock.now);
    t.onDirectiveSent(); // +43.6s on the live call
    clock.set(1_500);
    t.onAudioFrame(800); // the scripted turn it solicited
    clock.set(2_300);
    expect(t.onTurnComplete()).toMatchObject({ directivePreceded: true });
    clock.set(3_000);
    t.onCallerFragment(); // caller speaks; the server generates on its own
    clock.set(3_400);
    t.onAudioFrame(600); // the auto-reply — the invention channel
    clock.set(4_000);
    expect(t.onTurnComplete()).toMatchObject({ directivePreceded: false });
  });

  it("MT8c: an interrupted auto-reply carries the same attribution on its aborted summary", () => {
    // The 87.0s credit turn's sibling: an aborted invention must still be attributable,
    // or the detector goes blind exactly when the loop cut the turn short.
    const clock = makeClock(1_000);
    const t = new ModelTurnTracker(clock.now);
    t.onDirectiveSent();
    clock.set(1_500);
    t.onAudioFrame(800);
    clock.set(2_300);
    t.onTurnComplete();
    clock.set(5_000);
    t.onAudioFrame(400); // auto-reply opens
    clock.set(5_100);
    const reading = t.onInterrupted();
    expect(reading.abortedTurn).toMatchObject({ directivePreceded: false });
  });
});
