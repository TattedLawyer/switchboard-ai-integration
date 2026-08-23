// PreVerdictGate pins (PG1–PG5) + the F3 AMD-options pin — the decidable replacement for
// the library's `pauseReplyAuthorization` on the direct socket.
//
// WHY A GATE AND NOT A PAUSE: the installed library's AMD pauses PLAYBACK — the model
// still hears everything and generates (amd.ts:398 → agent_activity.ts:924, :2235,
// :3705-3712: tokens burn, transcripts flow, nothing reaches the callee). On the direct
// socket the gate is STRONGER: pre-verdict the model receives NO caller audio at all
// (AMD hears the caller via a separate tee that bypasses this gate), so it cannot speak
// to an answering machine even in principle. This is the voicemail-protection property.
//
// ANTI-VACUITY DOCTRINE FOR THE WHOLE FILE: a test asserting "nothing was forwarded"
// with ZERO frames offered passes with the gate deleted. Every closed-gate pin here
// offers real frames and asserts the DROPPED COUNT — the gate must be seen refusing.
import { describe, it, expect } from "vitest";
import { PreVerdictGate } from "../src/voice-direct-gates.js";
import { calleeAmdOptions } from "../src/voice-agent-session.js";

describe("PreVerdictGate — no caller audio to Gemini, no directives, until AMD settles", () => {
  it("PG1: pre-verdict, every offered frame is dropped and counted; directives are barred", () => {
    // VACUOUS IF no frames were offered (the gate could be deleted and 'nothing
    // forwarded' would hold trivially): five real frames go in, and the pin is the
    // count of refusals — droppedFrameCount() is the proof the gate did work.
    const gate = new PreVerdictGate();
    expect(gate.maySendDirective()).toBe(false);
    for (let i = 0; i < 5; i += 1) {
      expect(gate.offerCallerFrame(`frame-${i}`)).toBeNull();
    }
    expect(gate.droppedFrameCount()).toBe(5);
    expect(gate.forwardedFrameCount()).toBe(0);
  });

  it("PG2: a human verdict opens the gate — frames pass BY REFERENCE, directives allowed", () => {
    // VACUOUS IF the passed frame were only truthy-checked: the gate must hand back the
    // SAME object (toBe), because a copy here would double every audio buffer on the
    // hot path. The pre-verdict drops from PG1's shape are re-driven first so the
    // counters prove the transition, not just the end state.
    const gate = new PreVerdictGate();
    gate.offerCallerFrame("early-frame");
    gate.settle("human");
    const frame = { pcm: "..." };
    expect(gate.offerCallerFrame(frame)).toBe(frame);
    expect(gate.maySendDirective()).toBe(true);
    expect(gate.droppedFrameCount()).toBe(1);
    expect(gate.forwardedFrameCount()).toBe(1);
  });

  it("PG3: an unknown verdict opens the gate — the script runs for a possible human", () => {
    // `uncertain` maps to "unknown" and runIntakeCall RUNS the script for unknown
    // (hanging up on a possible human is worse than asking — voice-agent-session.ts:
    // 198-199). A gate that stayed closed on unknown would silence exactly those calls.
    // VACUOUS IF only maySendDirective were asserted: the audio half must open too.
    const gate = new PreVerdictGate();
    gate.settle("unknown");
    expect(gate.offerCallerFrame("frame")).toBe("frame");
    expect(gate.maySendDirective()).toBe(true);
    expect(gate.forwardedFrameCount()).toBe(1);
  });

  it("PG4: a machine verdict closes the gate FOREVER — frames offered after it still drop", () => {
    // The voicemail-protection property itself. VACUOUS IF no frames were offered after
    // the verdict (the deleted-gate trap this file's header names): three frames are
    // offered into the machine-closed gate and the dropped count must show all three.
    const gate = new PreVerdictGate();
    gate.settle("machine");
    for (let i = 0; i < 3; i += 1) {
      expect(gate.offerCallerFrame(`vm-frame-${i}`)).toBeNull();
    }
    expect(gate.maySendDirective()).toBe(false);
    expect(gate.droppedFrameCount()).toBe(3);
    expect(gate.forwardedFrameCount()).toBe(0);
  });

  it("PG5: machine is STICKY — no later verdict reopens, and machine closes an open gate", () => {
    // AMD settles once on the live path, but the gate must not depend on that: a
    // machine verdict is terminal in BOTH directions (a late 'human' cannot reopen a
    // voicemail call, and a late 'machine' must close an optimistically-opened gate).
    // VACUOUS IF frames were not offered after each transition — the counters are the
    // only observable proof the state actually moved.
    const closed = new PreVerdictGate();
    closed.settle("machine");
    closed.settle("human"); // must NOT reopen
    expect(closed.offerCallerFrame("f")).toBeNull();
    expect(closed.maySendDirective()).toBe(false);

    const reopened = new PreVerdictGate();
    reopened.settle("human");
    expect(reopened.offerCallerFrame("f1")).toBe("f1");
    reopened.settle("machine"); // machine wins whenever it arrives
    expect(reopened.offerCallerFrame("f2")).toBeNull();
    expect(reopened.maySendDirective()).toBe(false);
    expect(reopened.droppedFrameCount()).toBe(1);
    expect(reopened.forwardedFrameCount()).toBe(1);
  });
});

describe("F3: the AMD options the Step-1 shim host depends on", () => {
  it("calleeAmdOptions() still returns interruptOnMachine: false — load-bearing for the shim", () => {
    // WHY THIS PIN EXISTS (review amendment F3): the installed AMD calls
    // `session.interrupt({ force: true })` on a machine verdict when interruptOnMachine
    // is true (verified in the installed 1.6.4: dist/voice/amd.js:568-569) — and the
    // option DEFAULTS to true (amd.js:136), so an absent field flips it back. The Step-1
    // shim host that stands in for AgentSession will NOT implement `interrupt` — so
    // flipping this option would throw inside AMD's own timer callback on the exact
    // voicemail call AMD exists for, after every pin in this suite had passed. The
    // hangup stays OURS (report first, then deleteRoom — voice-agent-session.ts:
    // 864-866), which is also why it was false before the shim made it load-bearing
    // twice over. VACUOUS IF asserted with toBeFalsy: `undefined` would pass, and an
    // absent option takes the library DEFAULT — the literal false is the contract.
    expect(calleeAmdOptions().interruptOnMachine).toBe(false);
  });
});
