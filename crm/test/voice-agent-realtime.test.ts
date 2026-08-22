// Realtime-adapter pins — the fixes for the TWO DEFECTS reproduced on the 2026-08-21
// live call, tested here for the same reason as voice-agent-session.test.ts: the worker
// entry (`voice-agent/worker.ts`) sits outside every tsconfig, so every decidable piece
// of the fix lives in `crm/src/voice-agent-session.ts` (+ the shared identity constant in
// `call-bridge.ts`) where the compiler and these pins can see it.
//
// What was OBSERVED (logs, not theory):
//   DEFECT 1 — the caller's track logged `"name":"phone-callee" … "subscribed":false`,
//   once, never subscribed; AMD burned its full 20s and returned
//   `category:"uncertain", reason:"detection_timeout", speechDurationMs:0` while a human
//   was talking. The session was never bound to the SIP participant.
//   DEFECT 2 — `session.say()` threw `trying to generate speech from text without a TTS
//   model`: a native-audio realtime session has no TTS, so `say` can never work here.
//
// The pins (numbering follows the 2026-08-21 fix brief, distinct from the V1–V7 script
// pins in voice-agent-session.test.ts, which stand untouched):
//   V1: the session is bound to the CALLEE's identity at start — the same constant the
//       transport dials with — and AMD is restricted to that same participant.
//   V2: the scripted loop speaks via `generateReply` (never `say`), carries the approved
//       utterance into the instructions verbatim, and awaits completion before advancing.
//   V3: the LOOP still owns order — 3 approved questions means exactly 3 question turns,
//       in order, each answer persisted against its own question id.
//   V4: a wedged turn (playout never completes — the #2108 silent-wedge shape) advances
//       via the speak watchdog instead of hanging the call; a playout FAILURE still
//       propagates (honesty: no report is fabricated over a dead session).
//   V5: the AMD verdict mapping is unchanged — `uncertain` NEVER becomes `"human"`.
//   V6: per-turn persistence — a mid-call death after 2 of 3 answers leaves those 2
//       persisted and publishes nothing.
//   V7: an utterance that produced NO AUDIO throws — `SpeechHandle._markDone(error)`
//       stashes the error and RESOLVES `doneFut` (speech_handle.js:299–305 in the
//       installed 1.6.4; upstream livekit/agents #6224, whose fix-by-rejecting PR #6226
//       was rejected), so `waitForPlayout()` cannot distinguish spoken from silently
//       failed. The adapter now consults an injected speech observer (fed by
//       `agent_state_changed -> 'speaking'`, emitted from onFirstFrame) and THROWS when
//       no audio ever left — a silent failure must never be recorded as caller silence
//       and laundered into a normal-shaped report.
//   V8: AMD's detection budget is sized for POST-ANSWER speech, not ringback — the
//       worker gates `amd.execute()` on `sip.callStatus === 'active'` (bounded by
//       `awaitCallAnswered`, which throws rather than hang a never-answered job), and
//       `calleeAmdOptions()` raises `detectionTimeoutMs` as the backstop for a gate
//       that races or a carrier that feeds early media.
import { describe, it, expect, vi } from "vitest";
import { CALLEE_PARTICIPANT_IDENTITY, mapAmdCategory } from "../src/call-bridge.js";
import * as bridge from "../src/call-bridge.js";
import * as vas from "../src/voice-agent-session.js";
import type { CallJobMetadata } from "../src/call-bridge.js";
import {
  runIntakeCall,
  realtimeScriptedSpeech,
  speakTurnInstruction,
  startSessionBoundToCallee,
  calleeAmdOptions,
  INTAKE_INSTRUCTIONS,
  SPEAK_WATCHDOG_MS,
  type IntakeDeps,
  type RealtimeReplySession,
} from "../src/voice-agent-session.js";

const JOB3: CallJobMetadata = {
  v: 1,
  touchId: "00000000-0000-0000-0000-0000000000d4",
  contactId: "00000000-0000-0000-0000-0000000000a1",
  displayName: "Ana Reyes",
  openingLine: "Hi, may I speak with Ana Reyes?",
  prompts: [
    { id: "q1", questionKey: "budget", promptText: "What budget range are you working with?" },
    { id: "q2", questionKey: "timeline", promptText: "When are you hoping to move?" },
    { id: "q3", questionKey: "area", promptText: "Which areas are you considering?" },
  ],
};

/** A fake realtime session: records every generateReply instruction, exposes say() as a
 *  tripwire (calling it IS defect 2), and lets a test control playout resolution. */
function fakeRealtimeSession(opts?: { playout?: "resolve" | "never" | "reject" }) {
  const instructions: string[] = [];
  const sayCalls: string[] = [];
  const session = {
    say: (text: string) => {
      sayCalls.push(text);
      throw new Error("trying to generate speech from text without a TTS model");
    },
    generateReply: (o: { instructions: string }) => {
      instructions.push(o.instructions);
      return {
        waitForPlayout: (): Promise<void> => {
          if (opts?.playout === "never") return new Promise<void>(() => {});
          if (opts?.playout === "reject")
            return Promise.reject(new Error("the realtime session died mid-utterance"));
          return Promise.resolve();
        },
      };
    },
  };
  return { session: session as RealtimeReplySession & { say: (t: string) => void }, instructions, sayCalls };
}

/** IntakeDeps over the realtime seam, with an ordered op log (same shape as the V1–V7
 *  file's fakeDeps, but the session half is the REAL adapter over a fake session). */
function realtimeDeps(
  session: RealtimeReplySession,
  transcripts: Array<string | null | (() => never)>,
) {
  const ops: string[] = [];
  let i = 0;
  const deps: IntakeDeps = {
    session: {
      say: realtimeScriptedSpeech(session),
      nextFinalTranscript: async () => {
        const t = transcripts[i++];
        if (typeof t === "function") return t();
        return t ?? null;
      },
    },
    persistAnswer: async (questionId, value) => {
      ops.push(`persist:${questionId}:${value}`);
    },
    reached: async (ordinal) => {
      ops.push(`reached:${ordinal}`);
    },
    publishReport: async (report) => {
      ops.push(`report:${report.amdResult}:${String(report.conversation)}`);
    },
    hangUp: async () => {
      ops.push("hangUp");
    },
  };
  return { deps, ops };
}

describe("V1: the session is bound to the callee before anything is heard", () => {
  // mutation: drop `inputOptions` from startSessionBoundToCallee (link-to-first-
  //           participant default — the live defect) -> red.
  it("session.start carries the callee identity in inputOptions", async () => {
    const starts: Array<{
      agent: unknown;
      room: unknown;
      inputOptions?: { participantIdentity?: string };
    }> = [];
    const session = {
      start: async (o: (typeof starts)[number]) => {
        starts.push(o);
      },
    };
    const agent = { marker: "agent" };
    const room = { marker: "room" };

    await startSessionBoundToCallee(session, agent, room);

    expect(starts).toHaveLength(1);
    expect(starts[0]!.agent).toBe(agent);
    expect(starts[0]!.room).toBe(room);
    expect(starts[0]!.inputOptions).toEqual({
      participantIdentity: CALLEE_PARTICIPANT_IDENTITY,
    });
  });

  // mutation: remove participantIdentity from calleeAmdOptions -> red.
  it("AMD is restricted to the SAME participant the transport dials", () => {
    expect(calleeAmdOptions()).toEqual({
      interruptOnMachine: false,
      waitUntilFinished: false,
      participantIdentity: CALLEE_PARTICIPANT_IDENTITY,
      // V8: SHORT on purpose — the budget is enforced silence, not idle time (see the
      // V8 describe block). AMD is answer-gated now, so it never has to cover the ring.
      detectionTimeoutMs: 6_000,
    });
    // The identity is the one observed in the live log ("name":"phone-callee") — one
    // constant, shared with the transport's createSipParticipant call, so the dial side
    // and the bind side can never drift apart.
    expect(CALLEE_PARTICIPANT_IDENTITY).toBe("phone-callee");
  });
});

describe("V2: the loop speaks via generateReply — never say — and awaits completion", () => {
  // mutation: implement realtimeScriptedSpeech over session.say(text) -> red (the
  //           tripwire throws defect 2's exact error).
  it("one utterance = one generateReply carrying the approved words verbatim; say is never touched", async () => {
    const { session, instructions, sayCalls } = fakeRealtimeSession();
    const speak = realtimeScriptedSpeech(session);

    await speak("What budget range are you working with?");

    expect(sayCalls).toEqual([]);
    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toContain("What budget range are you working with?");
    expect(instructions[0]).toBe(
      speakTurnInstruction("What budget range are you working with?"),
    );
  });

  // mutation: return without awaiting waitForPlayout -> red (speak resolves while the
  //           playout gate is still held).
  it("speak resolves only after the playout completes", async () => {
    let release!: () => void;
    const session: RealtimeReplySession = {
      generateReply: () => ({
        waitForPlayout: () => new Promise<void>((r) => (release = r)),
      }),
    };
    let done = false;
    const p = realtimeScriptedSpeech(session)("When are you hoping to move?").then(() => {
      done = true;
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(done).toBe(false); // still playing — the loop must not advance yet
    release();
    await p;
    expect(done).toBe(true);
  });

  it("the standing instruction keeps the owner's three prohibitions while freeing the phrasing", () => {
    // Owner decision 2026-08-21: substance approved, wording the model's — but the three
    // lines that keep the call HERS survive verbatim in intent.
    expect(INTAKE_INSTRUCTIONS).toMatch(/never invent questions/i);
    expect(INTAKE_INSTRUCTIONS).toMatch(/never change what/i);
    expect(INTAKE_INSTRUCTIONS).toMatch(/never claim/i);
    expect(INTAKE_INSTRUCTIONS).not.toMatch(/exact scripted utterances/i);
  });
});

describe("V3: the loop still owns order — 3 questions, 3 turns, each answer on its own id", () => {
  // mutation: persist every answer against job.prompts[0].id -> red.
  it("exactly opening + 3 question turns, in order, persisted per question", async () => {
    const { session, instructions } = fakeRealtimeSession();
    const { deps, ops } = realtimeDeps(session, ["around 8 million", "before Christmas", "Makati or BGC"]);

    const report = await runIntakeCall(JOB3, "human", deps);

    // The MODEL owns phrasing; the LOOP owns which question is open and the order.
    expect(instructions).toHaveLength(4); // opening + q1 + q2 + q3, nothing more
    expect(instructions[0]).toContain("Hi, may I speak with Ana Reyes?");
    expect(instructions[1]).toContain("What budget range are you working with?");
    expect(instructions[2]).toContain("When are you hoping to move?");
    expect(instructions[3]).toContain("Which areas are you considering?");

    expect(ops.filter((o) => o.startsWith("persist:"))).toEqual([
      "persist:q1:around 8 million",
      "persist:q2:before Christmas",
      "persist:q3:Makati or BGC",
    ]);
    expect(report.answersPersisted).toBe(3);
    expect(report.reachedOrdinal).toBe(3);
    expect(report.conversation).toBe("identity_not_asked_complete");
  });
});

describe("V4: a wedged turn advances by watchdog; a dead session still propagates", () => {
  // mutation: remove the watchdog race (await playout alone) -> red (test times out).
  it("a playout that never completes (the #2108 wedge shape) releases after SPEAK_WATCHDOG_MS", async () => {
    vi.useFakeTimers();
    try {
      const { session } = fakeRealtimeSession({ playout: "never" });
      let done = false;
      const p = realtimeScriptedSpeech(session)("Hello, are you there?").then(() => {
        done = true;
      });

      await vi.advanceTimersByTimeAsync(SPEAK_WATCHDOG_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(done).toBe(true); // the call advances (or ends via the silence rule) — it
      // never dies quietly mid-question
    } finally {
      vi.useRealTimers();
    }
  });

  // mutation: catch the playout rejection and resolve (smoothing a death into silence)
  //           -> red.
  it("a playout FAILURE propagates — honesty over smoothness", async () => {
    const { session } = fakeRealtimeSession({ playout: "reject" });
    await expect(realtimeScriptedSpeech(session)("Anything")).rejects.toThrow(
      /died mid-utterance/,
    );
  });
});

describe("V5: the AMD verdict mapping is unchanged — uncertain is NEVER human", () => {
  // mutation: map "uncertain" to "human" in mapAmdCategory -> red.
  it("uncertain maps to unknown, end to end through the realtime seam", async () => {
    expect(mapAmdCategory("uncertain")).toBe("unknown");

    const { session } = fakeRealtimeSession();
    const { deps } = realtimeDeps(session, ["around 8 million", "soon", "Makati"]);
    const report = await runIntakeCall(JOB3, "uncertain", deps);

    expect(report.amdResult).toBe("unknown");
    expect(report.amdResult).not.toBe("human");
  });
});

describe("V6: per-turn persistence — a death after 2 of 3 answers leaves those 2", () => {
  // mutation: buffer answers and flush after the loop (the #2157 anti-pattern) -> red.
  it("two answers stand, nothing is fabricated for the third", async () => {
    const { session } = fakeRealtimeSession();
    const { deps, ops } = realtimeDeps(session, [
      "around 8 million",
      "before Christmas",
      () => {
        throw new Error("the call dropped on question three");
      },
    ]);

    await expect(runIntakeCall(JOB3, "human", deps)).rejects.toThrow(/dropped on question three/);

    expect(ops.filter((o) => o.startsWith("persist:"))).toEqual([
      "persist:q1:around 8 million",
      "persist:q2:before Christmas",
    ]);
    expect(ops.filter((o) => o.startsWith("report:"))).toEqual([]);
    expect(ops).not.toContain("hangUp"); // the hangup path is the transport's reconcile,
    // never a fabricated normal ending
  });
});

describe("V7: an utterance that produced NO AUDIO throws — silence is never fabricated", () => {
  // The defect: `SpeechHandle._markDone(error)` stashes the error and RESOLVES —
  // `waitForPlayout()` looks identical whether the agent spoke or silently failed (e.g.
  // the Google plugin's own 5s generateReply timeout, whose rejection the library
  // swallows). Without an audio-left signal, the loop records caller silence, and two of
  // those publish a NORMAL-SHAPED report — a fabricated outcome, violating
  // `runIntakeCall`'s "THROWS on any mid-call failure" promise (transport rule 2).
  // The observer is the worker's `agent_state_changed -> 'speaking'` flag (onFirstFrame:
  // real audio reached the room).

  // mutation: ignore the observer (return normally when playout resolves) -> red.
  //           RUN ✅ 2026-08-21 (grep-confirmed applied): `Tests  3 failed | 20 passed (23)`
  //           — this test, the watchdog-silent test, and the runIntakeCall honesty test.
  it("playout resolves but no speaking state ever fired -> throws, naming the utterance", async () => {
    const { session } = fakeRealtimeSession(); // playout resolves instantly
    const speak = vas.realtimeScriptedSpeech(session, {
      observer: { arm: () => {}, spoke: () => false },
    });

    await expect(speak("Hi, may I speak with Ana Reyes?")).rejects.toThrow(
      /Hi, may I speak with Ana Reyes\?/,
    );
    await expect(speak("Hi, may I speak with Ana Reyes?")).rejects.toThrow(
      /no audio|never sp|silently/i,
    );
  });

  it("speaking fired then playout resolved -> resolves (the normal turn), re-armed per utterance", async () => {
    // The observer is stateful exactly like the worker's: arm() clears the flag, the
    // session's first audio frame sets it.
    let audible = false;
    let arms = 0;
    const instructions: string[] = [];
    const session = {
      generateReply: (o: { instructions: string }) => {
        // arm() must ALREADY have cleared the flag when generateReply runs — a stale
        // 'speaking' from a previous utterance must never vouch for this one.
        expect(arms).toBe(instructions.length + 1);
        instructions.push(o.instructions);
        audible = true; // the fake's "first frame reached the room"
        return { waitForPlayout: () => Promise.resolve() };
      },
    };
    const speak = vas.realtimeScriptedSpeech(session, {
      observer: {
        arm: () => {
          arms += 1;
          audible = false;
        },
        spoke: () => audible,
      },
    });

    await expect(speak("What budget range are you working with?")).resolves.toBeUndefined();
    await expect(speak("When are you hoping to move?")).resolves.toBeUndefined();
    expect(instructions).toHaveLength(2);
    expect(arms).toBe(2); // once per utterance, never fewer
  });

  // mutation: throw whenever the watchdog fires, spoke or not -> red (a long courteous
  //           turn must not kill the call). RUN ✅ 2026-08-21 (grep-confirmed):
  //           `Tests  2 failed | 21 passed (23)` — this test AND the V4 wedge pin.
  it("watchdog expires but the agent DID speak -> resolves (slow, not dead)", async () => {
    vi.useFakeTimers();
    try {
      let audible = false;
      const session = {
        generateReply: () => {
          audible = true;
          return { waitForPlayout: () => new Promise<void>(() => {}) }; // never completes
        },
      };
      const speak = vas.realtimeScriptedSpeech(session, {
        observer: {
          arm: () => {
            audible = false;
          },
          spoke: () => audible,
        },
      });

      let outcome: "resolved" | "rejected" | null = null;
      const p = speak("Which areas are you considering?").then(
        () => {
          outcome = "resolved";
        },
        () => {
          outcome = "rejected";
        },
      );
      await vi.advanceTimersByTimeAsync(SPEAK_WATCHDOG_MS);
      await p;
      expect(outcome).toBe("resolved");
    } finally {
      vi.useRealTimers();
    }
  });

  // mutation: drop the spoke() check on the watchdog path -> red. RUN ✅ 2026-08-21 —
  //           covered by the ignore-the-observer run above (same guard).
  it("watchdog expires and NOTHING was ever heard -> throws, naming the watchdog", async () => {
    vi.useFakeTimers();
    try {
      const { session } = fakeRealtimeSession({ playout: "never" });
      const speak = vas.realtimeScriptedSpeech(session, {
        observer: { arm: () => {}, spoke: () => false },
      });

      let error: unknown = null;
      const p = speak("Hello, are you there?").catch((e) => {
        error = e;
      });
      await vi.advanceTimersByTimeAsync(SPEAK_WATCHDOG_MS);
      await p;
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).toMatch(/watchdog/i);
      expect(String((error as Error).message)).toMatch(/Hello, are you there\?/);
    } finally {
      vi.useRealTimers();
    }
  });

  // Free extra coverage of the ONE path that populates the stash: if the handle exposes
  // `exception()` (public, speech_handle.d.ts:134) and it returns anything defined, that
  // is the definitive stashed failure — throw it, whatever the observer saw.
  it("handle.exception() returning a defined error -> throws it", async () => {
    const session = {
      generateReply: () => ({
        waitForPlayout: () => Promise.resolve(),
        exception: () => new Error("generateReply timed out after 5s"),
      }),
    };
    const speak = vas.realtimeScriptedSpeech(session, {
      observer: { arm: () => {}, spoke: () => true },
    });

    await expect(speak("Anything")).rejects.toThrow(/timed out after 5s/);
  });

  // 🚨 The honesty property END TO END — the test that actually protects the promise in
  // the module header: a say() that silently fails must propagate out of runIntakeCall
  // with NO report published and NO hangup claimed.
  // mutation: smooth the silent failure into a silence (record + continue) -> red.
  it("a silently-failed utterance propagates out of runIntakeCall — no report is ever published", async () => {
    const { session } = fakeRealtimeSession(); // playout resolves; nothing was ever heard
    const ops: string[] = [];
    const deps: IntakeDeps = {
      session: {
        say: vas.realtimeScriptedSpeech(session, {
          observer: { arm: () => {}, spoke: () => false },
        }),
        nextFinalTranscript: async () => null,
      },
      persistAnswer: async (q, v) => {
        ops.push(`persist:${q}:${v}`);
      },
      reached: async (o) => {
        ops.push(`reached:${o}`);
      },
      publishReport: async () => {
        ops.push("report");
      },
      hangUp: async () => {
        ops.push("hangUp");
      },
    };

    await expect(runIntakeCall(JOB3, "human", deps)).rejects.toThrow(/no audio|never sp|silently/i);

    // Nothing was fabricated: no report, no hangup, no answers — the transport times out
    // on the missing report and the proposal stays visibly `executing` for reconcile.
    expect(ops).toEqual([]);
  });
});

describe("V0: the agent never invents an identity", () => {
  // 2026-08-21, PROVEN ON A LIVE CALL: the model answered a carrier screening greeting
  // with "Hi, this is Jordan. I'm making a quick call for my real estate broker" —
  // a FABRICATED human name, spoken ~8s BEFORE the approved opening line. That turn was
  // a SERVER-INITIATED reply (onInputSpeechStarted), not one we handed over, so nothing
  // in the per-turn path can reach it: only the STANDING instruction governs it.
  //
  // Root cause: the standing prompt named a ROLE ("on behalf of a real-estate broker")
  // and left the IDENTITY slot empty, so the model filled it. Naming the ABSENCE closes
  // it. (Google's own Live API guidance puts persona first for exactly this reason.)
  //
  // mutation: delete the "do not give yourself" sentence -> red.
  it("the standing instruction forbids self-naming — the slot is named, not left empty", () => {
    expect(INTAKE_INSTRUCTIONS).toMatch(/do not give yourself a personal name/i);
    expect(INTAKE_INSTRUCTIONS).toMatch(/assistant calling on behalf of/i);
  });

  it("the three prohibitions that make the call HERS survive alongside it", () => {
    // The loosening that licensed natural phrasing kept exactly these three. They are
    // the compliance spine; a persona sentence must not displace them.
    expect(INTAKE_INSTRUCTIONS).toMatch(/[Nn]ever invent questions/);
    expect(INTAKE_INSTRUCTIONS).toMatch(/never change what a handed question is asking/);
    expect(INTAKE_INSTRUCTIONS).toMatch(/never claim to have taken/);
  });

  it("stays short — leak frequency rises with prompt length (livekit/agents#5662)", () => {
    // A hard ceiling, not a style note: the standing instruction is sent as
    // `setup.systemInstruction` on EVERY call, and long system prompts are the reported
    // condition for Gemini 2.5 over SIP reciting them to the caller.
    expect(INTAKE_INSTRUCTIONS.length).toBeLessThan(1_200);
  });
});

describe("V8: AMD's detection budget cannot burn during ringback", () => {
  // The defect (installed 1.6.4, dist/voice/amd.js): execute() arms startDetectionTimer()
  // immediately (line 245) and gateListening() RE-ARMS it at track-subscribe (line 441)
  // — both BEFORE the `sip.callStatus === 'active'` wait; only startListening() (the
  // no-speech timer) is answer-gated. With a 60s ring budget, a callee answering after
  // ~20s got `uncertain/detection_timeout` pre-answer. Upstream fixed it in
  // livekit/agents-js #2226 (merged 2026-08-20, AFTER 1.6.4) — until we ship that
  // version, the worker gates execute() itself and raises the budget as a backstop.

  // 🚨 POLICY REVERSED 2026-08-21 by a live call. This test used to assert the budget was
  // DERIVED FROM THE RING (`ring + 20s` ≈ 80s). That was correct only while AMD started at
  // dial; `awaitCallAnswered` now gates execute() on the answer, so the ring is already
  // excluded — and the budget is not idle time, it is ENFORCED SILENCE: reply
  // authorization is held down for its whole duration (amd.ts:398 ->
  // agent_activity.ts:924 -> :2235 -> :3705-3712), so an 80s budget is up to 80s of a real
  // person hearing nothing. The pin now guards the opposite property: this number must
  // stay SMALL and must NOT track the ring.
  // mutation: restore `RINGING_TIMEOUT_S * 1_000 + 20_000` -> red (both assertions).
  //           RUN ✅ 2026-08-21 (grep-confirmed): `Tests  2 failed | 21 passed (23)`
  it("the detection budget is SHORT and decoupled from the ring — every ms of it is silence", () => {
    expect(vas.AMD_DETECTION_TIMEOUT_MS).toBe(6_000);
    // The load-bearing invariant: never again sized by the ring.
    expect(vas.AMD_DETECTION_TIMEOUT_MS).toBeLessThan(bridge.RINGING_TIMEOUT_S * 1_000);
    // Comfortably under the library's own stock 20s, because ours is post-answer only.
    expect(vas.AMD_DETECTION_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
    expect(calleeAmdOptions().detectionTimeoutMs).toBe(vas.AMD_DETECTION_TIMEOUT_MS);
  });

  // mutation: drop `waitUntilFinished: false` (library default is TRUE, amd.ts:360) -> red.
  it("waitUntilFinished is pinned OFF — with it on, ANY speech un-caps the budget and the agent stays mute", () => {
    // amd.ts:912 — `if (!(this.waitUntilFinished && hasSpeech)) { this.eotReached = true; }`
    // On the 2026-08-21 live call a carrier screening greeting counted as speech, the
    // timeout stopped capping, and AMD did not settle for 42s — releasing only when the
    // human hung up. Reply authorization was held down that entire time.
    expect(calleeAmdOptions().waitUntilFinished).toBe(false);
  });

  it("one ring budget, shared with the transport — 60s, under LiveKit's documented 80s cap", () => {
    expect(bridge.RINGING_TIMEOUT_S).toBe(60);
    expect(bridge.RINGING_TIMEOUT_S).toBeLessThanOrEqual(80);
  });

  it("the SIP vocabulary the worker's answer gate waits on is pinned", () => {
    // LiveKit's own AMD gates on exactly these strings (amd.js SIP_CALL_STATUS_ATTR).
    expect(vas.SIP_CALL_STATUS_ATTRIBUTE).toBe("sip.callStatus");
    expect(vas.SIP_CALL_STATUS_ACTIVE).toBe("active");
  });

  it("the answer-wait bound outlasts the transport's full ring plus grace — the wait can never outlive a legal ring by less", () => {
    expect(vas.CALL_ANSWER_WAIT_MS).toBe((bridge.RINGING_TIMEOUT_S + 15) * 1_000);
  });

  it("awaitCallAnswered resolves when the callee answers inside the bound", async () => {
    let seen: AbortSignal | undefined;
    await expect(
      vas.awaitCallAnswered(async (signal: AbortSignal) => {
        seen = signal;
      }, 5_000),
    ).resolves.toBeUndefined();
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(false);
  });

  // mutation: on the bound, return without aborting or throwing (the silent give-up)
  //           -> red. RUN ✅ 2026-08-21 (grep-confirmed): `Tests  1 failed | 22 passed (23)`.
  it("awaitCallAnswered throws at the bound and ABORTS the vendor wait — no hang, no fabricated report", async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      let error: unknown = null;
      const p = vas
        .awaitCallAnswered((signal: AbortSignal) => {
          seen = signal;
          return new Promise<void>(() => {}); // the attribute never flips
        }, 10_000)
        .catch((e: unknown) => {
          error = e;
        });
      await vi.advanceTimersByTimeAsync(10_000);
      await p;
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).toMatch(/answer/i);
      expect(seen!.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a vendor failure inside the wait propagates unchanged — honest, never smoothed", async () => {
    await expect(
      vas.awaitCallAnswered(async () => {
        throw new Error("Participant phone-callee disconnected while waiting for sip.callStatus");
      }, 5_000),
    ).rejects.toThrow(/disconnected/);
  });
});
