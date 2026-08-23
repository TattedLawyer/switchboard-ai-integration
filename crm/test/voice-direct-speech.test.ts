// directScriptedSpeech pins (DS1–DS11) — the direct-socket implementation of
// `ScriptedVoiceSession.say`, returning the EXISTING `SpeechDelivery` contract
// (voice-agent-session.ts:97-100). The intake loop above it is UNCHANGED; these pins
// hold the new channel to the same honesty rules the realtime adapter earned on live
// calls:
//   · `voicedAt` is the FIRST-FRAME time, never the say-call clock — the say-call stamp
//     is the exact lie the 2026-08-22 leak call persisted ("Uh" filed as an answer),
//     and e10a401 exists to prevent its return. Every delivered pin here SKEWS the
//     injected clock between the say call and the frame, so a call-clock stamp cannot
//     pass by coincidence.
//   · honest death, never a fabricated report: no frames + no caller evidence, watchdog
//     with no frames, or the socket-health latch (closed ≠ 1000, or an error) THROW.
//   · barge-in is REPORTED (`delivered:false, partial:false`), not swallowed — a void
//     return here is what let the old loop bind barged-in speech to a question nobody
//     heard.
import { describe, it, expect } from "vitest";
import { DirectSpeechChannel } from "../src/voice-direct-speech.js";
import type { DirectiveTurn } from "../src/voice-direct-events.js";

function makeClock(start: number) {
  let t = start;
  return { now: () => t, set: (v: number) => void (t = v) };
}

function harness(opts?: { watchdogMs?: number; graceMs?: number; clockStart?: number }) {
  const sent: DirectiveTurn[] = [];
  const clock = makeClock(opts?.clockStart ?? 1_000);
  const channel = new DirectSpeechChannel(
    { sendDirective: (t) => void sent.push(t) },
    { now: clock.now, watchdogMs: opts?.watchdogMs ?? 5_000, graceMs: opts?.graceMs ?? 50 },
  );
  return { sent, clock, channel };
}

describe("directScriptedSpeech — arm, one DirectiveTurn, race events against the watchdog", () => {
  it("DS1: delivered — first frame + un-interrupted turnComplete; voicedAt is the FIRST-FRAME clock", async () => {
    // THE e10a401 pin. The clock reads 1_000 at the say call, 777_777 when the first
    // frame lands, 999_999 at turnComplete: only the first-frame stamp satisfies the
    // assertion. VACUOUS IF the clock never moved (all three stamps identical — the
    // say-call-clock mutation would pass), or if a second frame were not fed (first-
    // frame-wins would be indistinguishable from last-frame-wins).
    const { sent, clock, channel } = harness();
    const p = channel.say("What budget range are you working with?");
    expect(sent).toHaveLength(1); // exactly ONE DirectiveTurn per say
    expect(sent[0]!.turnComplete).toBe(true);
    expect(sent[0]!.turns[0]!.role).toBe("user"); // the leak mechanism stays banned
    // The approved utterance rides VERBATIM inside the per-turn instruction.
    expect(sent[0]!.turns[0]!.parts[0]!.text).toContain(
      '"What budget range are you working with?"',
    );
    clock.set(777_777);
    channel.onAudioFrame();
    clock.set(888_888);
    channel.onAudioFrame(); // later frames must not move the stamp
    clock.set(999_999);
    channel.onTurnComplete();
    await expect(p).resolves.toEqual({ delivered: true, voicedAt: 777_777 });
  });

  it("DS2: the delivered claim DEPENDS on frames — turnComplete alone is not delivery", async () => {
    // The RED half of DS1: withhold every frame and the exact same terminal event must
    // produce an honest death, not delivered:true. A turnComplete with zero audio is a
    // generation that never made sound — reporting it delivered is the fabricated
    // report the contract bans. VACUOUS IF caller evidence were fed (that is DS5's
    // barge-in path): silence on BOTH sides is what makes this a death.
    const { channel } = harness({ graceMs: 30 });
    const p = channel.say("When are you hoping to move?");
    channel.onTurnComplete(); // no frames ever
    await expect(p).rejects.toThrow(/no audio/i);
  });

  it("DS3: partial — frames left, then interrupted; voicedAt still the first-frame clock", async () => {
    // The caller heard the question BEGIN, so a turn starting after voicedAt may be
    // answering it (voice-agent-session.ts:91-93). VACUOUS IF voicedAt were not
    // asserted against the skewed clock: partial with a wrong stamp misfiles exactly
    // like the leak call did.
    const { clock, channel } = harness();
    const p = channel.say("Which areas are you considering?");
    clock.set(75_336);
    channel.onAudioFrame();
    clock.set(76_100);
    channel.onInterrupted();
    await expect(p).resolves.toEqual({ delivered: false, partial: true, voicedAt: 75_336 });
  });

  it("DS4: barge-in before any frame — interrupted IS caller evidence, reported not thrown", async () => {
    // The 2026-08-22 discriminator: a caller talking over us is the OPPOSITE of a dead
    // line. No frames + interrupt = the question was never voiced; the loop must not
    // open its answer window (delivered:false, partial:false — no voicedAt field at
    // all). VACUOUS IF a frame were fed first (that is DS3), or if the assertion
    // allowed extra fields: toEqual pins that no fabricated voicedAt rides along.
    const { channel } = harness();
    const p = channel.say("What is your budget?");
    channel.onInterrupted();
    await expect(p).resolves.toEqual({ delivered: false, partial: false });
  });

  it("DS5: no frames + a caller fragment within the grace window — barge-in, not death", async () => {
    // The evidence arrives LATE on a real call (23ms after the interrupt there was no
    // transcript yet — voice-agent-session.ts:686-691), hence a grace window rather
    // than a synchronous check. VACUOUS IF the fragment were fed before turnComplete:
    // the grace path (evidence arriving while the death timer runs) would never
    // execute, and deleting the grace wait entirely would still pass.
    const { channel } = harness({ graceMs: 5_000 });
    const p = channel.say("What is your timeline?");
    channel.onTurnComplete(); // no audio: the death clock starts…
    channel.onCallerFragment(); // …and the caller's own voice stops it
    await expect(p).resolves.toEqual({ delivered: false, partial: false });
  });

  it("DS6: watchdog with no frames and no evidence THROWS, naming the watchdog", async () => {
    // The #2108-wedge bound on the direct path: nothing arrived at all — no frames, no
    // turn boundary, no caller. VACUOUS IF the message were not pinned: a generic
    // throw could come from anywhere (a typo'd field, a dead fake) and prove nothing
    // about the watchdog actually being armed.
    const { channel } = harness({ watchdogMs: 25, graceMs: 20 });
    const p = channel.say("Hello?");
    await expect(p).rejects.toThrow(/watchdog/i);
  });

  it("DS7: watchdog WITH frames resolves delivered — a slow courteous turn must not kill the call", async () => {
    // The realtime precedent, kept deliberately (voice-agent-session.ts:612-614): audio
    // left, the agent is merely slow; the answer watchdog still bounds the call behind
    // it. VACUOUS IF voicedAt were unasserted — resolving delivered with a watchdog-
    // time stamp would reintroduce the say-call-clock lie through the slow path.
    const { clock, channel } = harness({ watchdogMs: 25 });
    const p = channel.say("Let me tell you about the listing…");
    clock.set(444_444);
    channel.onAudioFrame(); // frames flow but turnComplete never comes
    await expect(p).resolves.toEqual({ delivered: true, voicedAt: 444_444 });
  });

  it("DS8: the socket-health latch — an abnormal close mid-say throws and stays latched", async () => {
    // A 1007-family kill (the socket's way of reporting our own protocol mistake) must
    // surface as the utterance's honest death AND poison every later say: the socket is
    // gone, and a directive 'sent' into it is a fabricated delivery. VACUOUS IF the
    // second say's directive count were not asserted: a latch that throws but still
    // sends would keep writing into a dead socket.
    const { sent, channel } = harness();
    const p = channel.say("Hi, may I speak with Ana Reyes?");
    channel.onClosed(1007, "Invalid frame payload data");
    await expect(p).rejects.toThrow(/1007/);
    await expect(channel.say("Hello again?")).rejects.toThrow(/socket/i);
    expect(sent).toHaveLength(1); // the latched channel sent NOTHING for the second say
  });

  it("DS9: an error event latches exactly like an abnormal close", async () => {
    // The other half of the latch. VACUOUS IF only the pending rejection were checked:
    // the latch property is that FUTURE says die immediately, before any directive.
    const { sent, channel } = harness();
    const p = channel.say("First question?");
    channel.onError("read ECONNRESET");
    await expect(p).rejects.toThrow(/ECONNRESET/);
    await expect(channel.say("Second question?")).rejects.toThrow(/socket/i);
    expect(sent).toHaveLength(1);
  });

  it("DS10: a CLEAN close (1000) mid-say still rejects the pending say — nothing can arrive anymore", async () => {
    // The callee hung up mid-utterance: code 1000 is not ill health, but the pending
    // delivery can never complete and must not sit on the watchdog pretending it might.
    // VACUOUS IF the close were fed after settlement — feed it while the say is the
    // only thing in flight.
    const { channel } = harness({ watchdogMs: 60_000 });
    const p = channel.say("Do you have any other questions?");
    channel.onClosed(1000, "");
    await expect(p).rejects.toThrow(/closed/i);
  });

  it("DS11: one utterance at a time — a second say while one is in flight is refused", async () => {
    // The #2059 discipline the whole session file is built on: this module never has
    // two speeches in flight to supersede each other. VACUOUS IF the first say were
    // already settled, or if the refusal also killed the FIRST say — the first must
    // still resolve normally after the refusal.
    const { sent, clock, channel } = harness();
    const p1 = channel.say("Question one?");
    await expect(channel.say("Question two?")).rejects.toThrow(/in flight|one at a time/i);
    expect(sent).toHaveLength(1); // the refused say sent nothing
    clock.set(50_000);
    channel.onAudioFrame();
    channel.onTurnComplete();
    await expect(p1).resolves.toEqual({ delivered: true, voicedAt: 50_000 });
  });
});
