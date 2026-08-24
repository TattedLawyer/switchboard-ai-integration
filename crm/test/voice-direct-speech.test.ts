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
import { MODEL_TURN_FINALIZE_MARGIN_MS } from "../src/voice-agent-session.js";
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

// ─── DS12–DS15: the model-turn gate — a directive never departs into an in-flight
// model turn (the 2026-08-23 self-interrupt fix), and ARM MOVES TO THE SEND ──────────
//
// The measured mechanism these pins close: a `sendClientContent` landing while the
// server's playout estimate is still running makes 3.1 emit `interrupted` 47–134ms
// later with NO caller audio (probe E7/E11, n=12) — the live call's 3/3 interrupts.
// The gate is consulted at say(); while a turn is in flight the directive is PARKED,
// released at the wire's turnComplete, bounded by the gate's deadline (the tracker
// caps it absolutely). And because a wait now sits between say() and the send, the
// arm moves WITH the send: frames arriving during the wait belong to the in-flight
// turn and must never stamp `voicedAt` — the e10a401-family misattribution the live
// log caught at +119.37s (the deferral's frames stamped a say armed mid-flight).
function gatedHarness(opts?: { watchdogMs?: number; graceMs?: number; clockStart?: number }) {
  const base = harness(opts);
  let deadline: number | undefined;
  const channel = new DirectSpeechChannel(
    { sendDirective: (t) => void base.sent.push(t) },
    {
      now: base.clock.now,
      watchdogMs: opts?.watchdogMs ?? 5_000,
      graceMs: opts?.graceMs ?? 50,
      turnGate: { sendWaitDeadline: () => deadline },
    },
  );
  return {
    sent: base.sent,
    clock: base.clock,
    channel,
    setDeadline: (d: number | undefined) => void (deadline = d),
  };
}

describe("directScriptedSpeech — the model-turn gate and arm-at-send", () => {
  it("DS12: a say during an in-flight model turn is PARKED — sent at the turn's finalize, and only post-send frames stamp voicedAt", async () => {
    // The FD1 ordering property pinned BEHAVIOURALLY (a source regex proves a call
    // exists, not that it is awaited): the fake host records sends; events are fed;
    // the order is asserted. VACUOUS IF the gate reported no turn in flight (that is
    // DS1's immediate-send path), or if the pre-send frame were not fed (arm-at-send
    // would be indistinguishable from arm-at-say).
    const { sent, clock, channel, setDeadline } = gatedHarness();
    setDeadline(999_999); // a model turn is in flight; its bound is far away
    const p = channel.say("When are you hoping to move?");
    expect(sent).toHaveLength(0); // NOT on the wire — the old code sent here
    // One-at-a-time holds while parked too (#2059).
    await expect(channel.say("Another?")).rejects.toThrow(/in flight|one at a time/i);
    clock.set(5_000);
    channel.onAudioFrame(); // the IN-FLIGHT turn's audio — must never become voicedAt
    clock.set(6_000);
    setDeadline(undefined); // the tracker closed the turn…
    channel.onTurnComplete(); // …at the wire's own finalize signal
    expect(sent).toHaveLength(1); // released: the directive departs NOW
    clock.set(6_500);
    channel.onAudioFrame(); // OUR turn's first frame
    clock.set(7_000);
    channel.onTurnComplete();
    await expect(p).resolves.toEqual({ delivered: true, voicedAt: 6_500 }); // never 5_000
  });

  it("DS13: pre-send frames + an interrupt right after the send report NO voicedAt at all — the e10a401 pin", async () => {
    // The live log's +119.37s misattribution: the deferral's audio stamped a say that
    // had not reached the wire, so the interrupt filed {partial:true, voicedAt} and
    // polluted askedAt for a question the caller NEVER heard begin. VACUOUS IF the
    // pre-send frame were omitted (DS4 already covers a clean no-frame barge-in).
    const { sent, clock, channel, setDeadline } = gatedHarness();
    setDeadline(999_999);
    const p = channel.say("Have you been working with anyone else?");
    clock.set(5_000);
    channel.onAudioFrame(); // in-flight deferral audio, pre-send
    setDeadline(undefined);
    channel.onTurnComplete(); // releases the send
    expect(sent).toHaveLength(1);
    clock.set(5_100);
    channel.onInterrupted(); // no post-send frames: the question was never voiced
    await expect(p).resolves.toEqual({ delivered: false, partial: false }); // no voicedAt
  });

  it("DS14: the park is BOUNDED — at the gate's deadline plus the finalize margin the directive departs even if no finalize ever arrived", async () => {
    // The cap half of the invariant: a server that withholds turnComplete past its own
    // estimate must not wedge the say forever (the tracker's absolute cap feeds this
    // deadline). The park's bound is the gate deadline PLUS the finalize margin —
    // the dry-socket estimate held to ±4ms, and a bound firing AT the estimate can
    // race the real turnComplete (the server-model suite's deletion run ended that
    // race in the aborted turn's finalize landing on the fresh say and the honest-
    // death throw killing the call) — so departure is asserted only after BOTH the
    // deadline and the margin have passed, and the finalize itself never arrives.
    // VACUOUS IF the deadline were already past at the say call (that sends
    // immediately) — the clock crosses the bound only AFTER the park.
    const { sent, clock, channel, setDeadline } = gatedHarness({ clockStart: 1_000 });
    setDeadline(1_040); // in flight, gate deadline 40ms away; the park's bound adds the margin
    const p = channel.say("Hello?");
    expect(sent).toHaveLength(0);
    clock.set(1_040 + MODEL_TURN_FINALIZE_MARGIN_MS + 10); // the bound passes…
    // …and the park's timer (armed for bound − sayClock ms of real time) fires:
    await new Promise((r) => setTimeout(r, 40 + MODEL_TURN_FINALIZE_MARGIN_MS + 60));
    expect(sent).toHaveLength(1); // departed at the bound, gate still claiming in-flight
    clock.set(2_000);
    channel.onAudioFrame();
    channel.onTurnComplete();
    await expect(p).resolves.toEqual({ delivered: true, voicedAt: 2_000 });
  });

  it("DS15: a socket death while parked rejects the say and sends NOTHING", async () => {
    // A directive into a dead socket is a fabricated delivery (the latch's rule) —
    // parking must not create a path around it. VACUOUS IF the say had already been
    // sent (that is DS8): the point is the parked directive never departs.
    const { sent, channel, setDeadline } = gatedHarness();
    setDeadline(999_999);
    const p = channel.say("First question?");
    expect(sent).toHaveLength(0);
    channel.onClosed(1007, "Invalid frame payload data");
    await expect(p).rejects.toThrow(/1007/);
    expect(sent).toHaveLength(0); // still nothing on the wire
    await expect(channel.say("Again?")).rejects.toThrow(/socket/i);
  });
});
