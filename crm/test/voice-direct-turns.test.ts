// TurnAssembler pins (TA1–TA8) — the caller-turn state machine that will feed
// `nextFinalTranscript` on the direct socket, driven by RAW FRAGMENT SEQUENCES taken
// from the winning call (PROOF-direct-socket-all4-passed.log). Feeding pre-assembled
// finals would make the assembler decorative — every sequence below is the wire's own
// shape: fragments with leading spaces, interrupts that beat their fragments, batches
// that land seconds after speech began.
//
// The clock is INJECTED (this repo's date-boundary lesson: three failures, one root
// cause — decidable logic never calls Date.now() itself), and every pin skews it
// between events so a timestamp taken at the WRONG moment cannot pass by coincidence.
//
// THE TWO F4 CASES (review amendment, both live-observed):
//   (a) `interrupted` and `turnComplete` 2ms apart with the caller's fragments arriving
//       only AFTER (log :168-176: interrupted@72781, turn-complete@72783, " Uh…" from
//       73481). The naive rule finalizes an EMPTY turn and loses the interrupt-time
//       stamp — the stamp the binding table needs, because the caller demonstrably
//       began speaking at the interrupt, not at the transcription's late arrival.
//   (b) fragments can arrive as ONE end-of-utterance batch ~3s after speech began (log
//       :60, " connectivity, New York." at 25855 for speech begun ~22s). If window i
//       times out mid-answer and say(i+1) voices before the batch lands, bindTurn files
//       the answer under i+1 — the exact misfile class e10a401 exists to prevent. The
//       mitigation surfaced here is `isTurnOpen()`: the loop can see a turn is open and
//       extend the window instead of expiring onto a mid-speech caller.
import { describe, it, expect } from "vitest";
import { TurnAssembler } from "../src/voice-direct-turns.js";

function makeClock(start: number) {
  let t = start;
  return { now: () => t, set: (v: number) => void (t = v) };
}

describe("TurnAssembler — turns open at first evidence, finalize on turn boundaries", () => {
  it("TA1: fragments accumulate; turnComplete emits ONE TimedTranscript stamped at the FIRST fragment", () => {
    // The winning call's own fragment run (log :86-97). VACUOUS IF the clock never
    // moved between fragments: turnStartedAt stamped at the LAST fragment — or at
    // finalize — would be indistinguishable from first-fragment time. Every event here
    // advances the clock, so only the first-fragment stamp passes.
    const clock = makeClock(36_320);
    const a = new TurnAssembler(clock.now);
    a.onInputTranscription(" I");
    clock.set(36_567);
    a.onInputTranscription(" just");
    clock.set(37_952);
    a.onInputTranscription(" want to know how many bedrooms it was.");
    clock.set(41_794);
    const turn = a.onTurnComplete();
    expect(turn).toEqual({
      transcript: "I just want to know how many bedrooms it was.",
      turnStartedAt: 36_320,
    });
  });

  it("TA2: whitespace-only assemblies are DISCARDED and the turn fully closes (V2 semantics)", () => {
    // The existing loop treats whitespace as silence, not an answer
    // (voice-agent-session.ts:375). VACUOUS IF we stopped at "returns null": the real
    // hazard is a stale turnStartedAt leaking into the NEXT real turn — so the pin
    // drives a second, later turn and asserts it gets its OWN (later) stamp.
    const clock = makeClock(10_000);
    const a = new TurnAssembler(clock.now);
    a.onInputTranscription("   ");
    clock.set(10_400);
    expect(a.onTurnComplete()).toBeNull();
    expect(a.isTurnOpen()).toBe(false);
    clock.set(20_000);
    a.onInputTranscription(" hello");
    clock.set(20_300);
    expect(a.onTurnComplete()).toEqual({ transcript: "hello", turnStartedAt: 20_000 });
  });

  it("TA3 (F4a): interrupt → turnComplete 2ms later → fragments AFTER — the interrupt stamp carries forward", () => {
    // The log's exact shape: interrupted@72781, turn-complete@72783 (log :168-170),
    // fragments " Uh…do you want to hang up now?" only from 73481 (:172-176), finalized
    // by the NEXT turn-complete@78363 (:190). The naive rule emits an empty turn at
    // 72783 and stamps the real words at 73481 — losing the one timestamp that proves
    // the caller began at the interrupt. VACUOUS IF the fragments arrived before the
    // first turnComplete (any implementation passes) or if turnStartedAt were not
    // asserted against the SKEWED clock (the carried stamp is the entire point).
    const clock = makeClock(72_781);
    const a = new TurnAssembler(clock.now);
    a.onInterrupted();
    clock.set(72_783);
    expect(a.onTurnComplete()).toBeNull(); // an open-but-empty turn finalizes into NOTHING…
    expect(a.isTurnOpen()).toBe(true); // …but does NOT close: the stamp is carried
    clock.set(73_481);
    a.onInputTranscription(" Uh");
    clock.set(73_612);
    a.onInputTranscription(",");
    clock.set(74_040);
    a.onInputTranscription(" do you want to hang up now?");
    clock.set(78_363);
    expect(a.onTurnComplete()).toEqual({
      transcript: "Uh, do you want to hang up now?",
      turnStartedAt: 72_781, // the INTERRUPT time, not the fragments' late arrival
    });
    expect(a.isTurnOpen()).toBe(false);
  });

  it("TA4 (F4b): isTurnOpen() is true exactly while a turn is accumulating", () => {
    // The window-extension surface: the loop reads this to keep window i alive while an
    // end-of-utterance batch is still landing (log :60). VACUOUS IF only the closed
    // states were asserted — `return false` passes those — or only the open state —
    // `return true` passes that. Both phases, in sequence, or the surface is decoration.
    const clock = makeClock(22_000);
    const a = new TurnAssembler(clock.now);
    expect(a.isTurnOpen()).toBe(false);
    a.onInputTranscription(" connectivity, New York.");
    expect(a.isTurnOpen()).toBe(true);
    clock.set(25_855);
    expect(a.onTurnComplete()).toEqual({
      transcript: "connectivity, New York.",
      turnStartedAt: 22_000,
    });
    expect(a.isTurnOpen()).toBe(false);
  });

  it("TA5: an interrupt during an already-open turn does NOT restamp it", () => {
    // First evidence wins: the caller began at their first fragment; a later interrupt
    // is the model being cut off mid-reply, not a new caller turn. VACUOUS IF the clock
    // did not move before the interrupt — restamping would then be invisible.
    const clock = makeClock(5_000);
    const a = new TurnAssembler(clock.now);
    a.onInputTranscription(" so");
    clock.set(6_500);
    a.onInterrupted();
    clock.set(7_000);
    a.onInputTranscription(" anyway");
    clock.set(7_500);
    expect(a.onTurnComplete()).toEqual({ transcript: "so anyway", turnStartedAt: 5_000 });
  });

  it("TA6: say() re-arming finalizes a pending turn — the queue must not straddle windows", () => {
    // A new directive opens a new answer window; whatever the caller had said belongs
    // to the OLD one. VACUOUS IF the assembler were empty at re-arm (null is the
    // trivially-passing answer): the pin feeds real fragments first.
    const clock = makeClock(50_000);
    const a = new TurnAssembler(clock.now);
    a.onInputTranscription(" the cost.");
    clock.set(51_000);
    expect(a.onSayRearm()).toEqual({ transcript: "the cost.", turnStartedAt: 50_000 });
    expect(a.isTurnOpen()).toBe(false);
  });

  it("TA7: a carried interrupt-stamp survives a say() re-arm too", () => {
    // Same F4a hazard on the other finalize path: the loop may re-arm within the 2ms-
    // to-700ms gap before the barged-in caller's fragments land. The interrupt evidence
    // is not yet consumed, so the stamp must carry. VACUOUS IF turnStartedAt were not
    // asserted: emitting the words with a re-arm-time stamp is the misfile itself.
    const clock = makeClock(72_781);
    const a = new TurnAssembler(clock.now);
    a.onInterrupted();
    clock.set(72_900);
    expect(a.onSayRearm()).toBeNull();
    expect(a.isTurnOpen()).toBe(true);
    clock.set(73_481);
    a.onInputTranscription(" wait, one more thing");
    clock.set(74_000);
    expect(a.onTurnComplete()).toEqual({
      transcript: "wait, one more thing",
      turnStartedAt: 72_781,
    });
  });

  it("TA8: drain finalizes what exists and fully resets — even a carried empty turn", () => {
    // Drain is the end of the line (hangup teardown): real words are emitted, but a
    // fragment-less interrupt carry is released — there will never be fragments to
    // carry it TO, and an assembler still 'open' after drain would leak state into
    // nothing. VACUOUS IF only one of the two drains were exercised: the first pins
    // emission, the second pins that carry does not outlive the call.
    const clock = makeClock(99_000);
    const a = new TurnAssembler(clock.now);
    a.onInputTranscription(" I'll talk to you later. Thank you.");
    clock.set(100_806);
    expect(a.drain()).toEqual({
      transcript: "I'll talk to you later. Thank you.",
      turnStartedAt: 99_000,
    });
    expect(a.isTurnOpen()).toBe(false);
    a.onInterrupted();
    expect(a.isTurnOpen()).toBe(true);
    expect(a.drain()).toBeNull();
    expect(a.isTurnOpen()).toBe(false); // the carry died with the call, not after it
  });
});

describe("TurnAssembler — the open turn's stamp is visible for the loop's age-bounded extension", () => {
  it("TA9: openTurnStartedAt() exposes the open turn's stamp — including a carried one — and goes undefined at finalize", () => {
    // The age discriminator the answer-window invariant needs: F4a's carry can hold
    // isTurnOpen() true FOREVER, so the loop age-bounds its window extension against
    // the turn's START — which this getter is the only surface for. VACUOUS IF only
    // the open state were read (return this.now() would pass): the CARRIED stamp must
    // survive an empty finalize (the old stamp, not a restamp), and the closed states
    // must read undefined.
    const clock = makeClock(40_000);
    const a = new TurnAssembler(clock.now);
    expect(a.openTurnStartedAt()).toBeUndefined();
    a.onInterrupted();
    clock.set(41_000);
    expect(a.openTurnStartedAt()).toBe(40_000); // the interrupt stamp, not now()
    expect(a.onTurnComplete()).toBeNull(); // F4a: empty finalize carries…
    clock.set(55_000);
    expect(a.openTurnStartedAt()).toBe(40_000); // …the ORIGINAL stamp, however stale
    a.onInputTranscription(" finally");
    clock.set(56_000);
    expect(a.onTurnComplete()).toEqual({ transcript: "finally", turnStartedAt: 40_000 });
    expect(a.openTurnStartedAt()).toBeUndefined();
  });
});
