// Call transport pins — the vendor seam's two exports, NEITHER of which may reach a
// telephone.
//
// P1: `stubPlaceCall` is TYPE-CHECKED against the real `PlaceCall` (the annotation lives
//     in `src/call-transport.ts`, inside the `npm run typecheck` perimeter — unlike the
//     loop's `stubSender`, which sits outside every tsconfig) and returns a canned
//     no-answer WITHOUT touching the context's callbacks or any socket.
// P6: `livekitPlaceCall` THROWS its not-implemented error at CONSTRUCTION — it must never
//     silently no-op, because a no-op that returns a `CallResult` would drive
//     `finishExecution({ok:true})` and an invented disposition for a call nobody placed.
import { describe, it, expect } from "vitest";
import type { CallContext, PlaceCall } from "../src/executor.js";
import {
  stubPlaceCall,
  livekitPlaceCall,
  type LiveKitCallConfig,
} from "../src/call-transport.js";

/** A context that records every callback, so silence can be asserted. */
function recordingContext(): { ctx: CallContext; callbacks: string[] } {
  const callbacks: string[] = [];
  const ctx: CallContext = {
    touchId: "00000000-0000-0000-0000-0000000000d4",
    payload: {
      contact_id: "00000000-0000-0000-0000-0000000000a1",
      phone_number_id: "00000000-0000-0000-0000-0000000000b2",
      phone_e164: "+639171234567",
      display_name: "Ana Reyes",
      opening_line: "Hi, may I speak with Ana Reyes?",
      question_set_id: "00000000-0000-0000-0000-0000000000c3",
      context: { source_detail: "Rotary breakfast", looking_for: "a 2BR near Alabang" },
    },
    prompts: [
      { id: "q1", questionKey: "budget", promptText: "What budget range are you working with?" },
      { id: "q2", questionKey: "timeline", promptText: "When are you hoping to move?" },
    ],
    answer: async () => {
      callbacks.push("answer");
    },
    reached: async () => {
      callbacks.push("reached");
    },
  };
  return { ctx, callbacks };
}

describe("P1: the stub is a typed PlaceCall that rings nobody", () => {
  // mutation: change the canned result's `sipStatus` to 200 -> red (a stub that reports a
  //           pick-up would launder "nothing happened" into contact). RUN ✅ 2026-08-18
  //   Observed: `Tests  1 failed | 1 passed (2)`
  //     AssertionError: expected { transport: { sipStatus: 200 }, …(1) } to deeply equal
  //     { transport: { sipStatus: 480 }, …(1) }
  it("returns the canned no-answer and never invokes a callback", async () => {
    // The load-bearing type conformance is the `: PlaceCall` annotation in
    // `src/call-transport.ts`; this assignment restates it where the behaviour is pinned.
    const typed: PlaceCall = stubPlaceCall;
    const { ctx, callbacks } = recordingContext();

    const result = await typed(ctx);

    expect(result).toEqual({ transport: { sipStatus: 480 }, conversation: null });
    // No answer was collected and no question was reached — nobody was called.
    expect(callbacks).toEqual([]);
  });
});

describe("P6: livekitPlaceCall refuses to exist quietly", () => {
  // mutation: return `stubPlaceCall` from the factory instead of throwing -> red (a
  //           fully-configured vendor env would then REHEARSE while claiming to be live).
  //           RUN ✅ 2026-08-18
  //   Observed: `Tests  1 failed | 1 passed (2)`
  //     AssertionError: expected [Function] to throw an error
  it("throws the explicit not-implemented error at construction", () => {
    const cfg: LiveKitCallConfig = {
      url: "wss://example.livekit.invalid",
      apiKey: "lk-key",
      apiSecret: "lk-secret",
      sipTrunkId: "trunk-1",
      modelApiKey: "model-key",
    };
    expect(() => livekitPlaceCall(cfg)).toThrow(
      /not implemented — no vendor credentials wired yet \(T16\)/,
    );
  });
});
