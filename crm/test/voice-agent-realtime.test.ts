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
//   V9 (2026-08-23, the leak-call fix — touch `0fcf2180-…`): `say` reports DELIVERY.
//       The voiced-at time comes from the LIBRARY — the assistant `ChatMessage` the
//       realtime path commits with `createdAt = startedSpeakingAt` and an `interrupted`
//       flag (installed 1.6.4 src, agent_activity.ts:3956–3968, reached via the public
//       `SpeechHandle.chatItems`, speech_handle.ts:243) — never from our clock at the
//       say call, which is exactly the stamp that filed "Uh" as a persisted answer.
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
  // NOTE (2026-08-23, the delivery fix): the invariant is one SAY CALL = one
  // generateReply. A re-asked question is legitimately TWO generateReply turns — but
  // that is the LOOP calling say twice (voice-agent-session.test.ts V11), never this
  // adapter fanning out.
  it("one say call = one generateReply carrying the approved words verbatim; say is never touched", async () => {
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
    // 🔴 THIS PIN WAS INVERTED ON 2026-08-22, AND A REAL PERSON PAID FOR IT.
    // It used to assert `not.toContain("hangUp")`, reasoning that "the hangup path is
    // the transport's reconcile, never a fabricated normal ending". That conflated two
    // different things: publishing a REPORT (which would fabricate an outcome, and is
    // still forbidden — see the assertion above) and HANGING UP THE PHONE (which is
    // simple courtesy to whoever is holding it).
    // On the live call the owner was left listening to silence until he gave up,
    // because nothing hung up after the throw. The transport polls for a report for
    // SIXTEEN MINUTES and cannot tell "call in progress" from "worker corpse in the
    // room" — it only noticed when he hung up himself.
    // The transport's own rule 2 already had the right shape: "cleanup, THEN a typed
    // throw". Cleanup-then-throw IS the honest death; the worker was the one party not
    // honouring it. No report, no invented disposition, proposal still visibly stuck for
    // a human — and the line released.
    // mutation: drop the hangUp from runIntakeCall's failure path -> red.
    expect(ops.filter((o) => o === "hangUp")).toEqual(["hangUp"]);
  });

  it("a hangUp that itself fails never masks the original error", async () => {
    // The failure being reported is the one worth keeping. A courtesy hangup that
    // throws on the way out must not become the error a human debugs.
    const { session } = fakeRealtimeSession();
    const { deps, ops } = realtimeDeps(session, [
      () => {
        throw new Error("the call dropped on question one");
      },
    ]);
    deps.hangUp = async () => {
      throw new Error("deleteRoom exploded");
    };

    await expect(runIntakeCall(JOB3, "human", deps)).rejects.toThrow(/dropped on question one/);
    expect(ops.filter((o) => o.startsWith("report:"))).toEqual([]);
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

    // Since the 2026-08-22 leak-call fix, say resolves to a DELIVERY outcome — asserting
    // `toBeUndefined()` here would pin the old void contract that let the loop stamp
    // asked-at from its own clock.
    await expect(speak("What budget range are you working with?")).resolves.toMatchObject({
      delivered: true,
    });
    await expect(speak("When are you hoping to move?")).resolves.toMatchObject({
      delivered: true,
    });
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

      let outcome: unknown = null;
      const p = speak("Which areas are you considering?").then(
        (delivery) => {
          outcome = delivery;
        },
        () => {
          outcome = "rejected";
        },
      );
      await vi.advanceTimersByTimeAsync(SPEAK_WATCHDOG_MS);
      await p;
      // Slow, not dead — and since the delivery fix, REPORTED as delivered (audio left;
      // no committed item on this fake, so the voiced-at falls back — see V9).
      expect(outcome).toMatchObject({ delivered: true });
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

    // Nothing is FABRICATED — no report, no answers — and the proposal stays visibly
    // `executing` for reconcile. But the line IS released: leaving a real person holding
    // a silent phone is not honesty, it is just rudeness with good paperwork. (This
    // assertion read `toEqual([])` until 2026-08-22, when a live call proved the cost.)
    expect(ops.filter((o) => o.startsWith("report:"))).toEqual([]);
    expect(ops.filter((o) => o.startsWith("persist:"))).toEqual([]);
    expect(ops).toEqual(["hangUp"]);
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

  it("stays bounded — leak frequency rises with prompt length (livekit/agents#5662)", () => {
    // PIN DELIBERATELY RAISED 2026-08-24, from 1_200 to 3_000: the invention incident
    // (live call, touch 2f7ecfae — unapproved credit-score and fabricated-address
    // questions) forced the tight rewrite, whose whitelist framing + named auto-reply
    // moment + banned categories measured 0/4 invention vs 4/4 under the short text
    // (probe-invent findings E3/E5). The #5662 leak was reported on the PLUGIN path
    // (2.5 over SIP); the direct-socket path carries ONE copy of the instruction and
    // survived its own leak call (2026-08-23). The ceiling stays as a tripwire against
    // unbounded growth, not as the old 1_200 which the safety content now exceeds.
    expect(INTAKE_INSTRUCTIONS.length).toBeLessThan(3_000);
  });
});

describe("V7b: a caller who BARGES IN is not a silent failure", () => {
  // 🔴 2026-08-22, KILLED A LIVE CALL WITH THE OWNER ON THE LINE. He said "Uh, can I ask
  // you—", the agent yielded ("Sure, go ahead."), and when he spoke again the next
  // scripted turn was cancelled BEFORE its first audio frame. No audio ever reached the
  // room, so the silent-utterance guard threw and the call died mid-sentence.
  //
  // 🚨 THE OBVIOUS FIX DOES NOT WORK, AND RESEARCH CAUGHT IT BEFORE IT SHIPPED: checking
  // `SpeechHandle.interrupted` would NOT have fired here. The plugin emits
  // `input_speech_started` (which is what sets `interrupted`) ONLY when no generateReply
  // is pending — `realtime_api.ts:1290-1296` and `:1730-1731` both gate on
  // `!this.pendingGenerationFut`. On the live call the server's `interrupted:true`
  // arrived 1.0s AFTER our generateReply was issued and while that future was still
  // pending, so the interrupt never propagated: the handle completed UN-interrupted,
  // with no stashed error and zero audio. Indistinguishable, at that instant, from a
  // genuine silent death.
  //
  // So the discriminator cannot be the handle — it must be EVIDENCE THAT THE CALLER
  // SPOKE. That evidence arrives late (the transcript of the barged-in speech did not
  // exist yet 23ms after the interrupt), which is why a GRACE WINDOW is required rather
  // than a synchronous check.
  //
  // The honesty property is preserved exactly where it matters: no audio AND no caller
  // evidence still throws, still publishes no report.
  const utterance = "Have you been working with anyone else on the search?";

  function handleFake() {
    return { waitForPlayout: async () => {} };
  }

  it("no audio + caller spoke during the grace window -> NOT a failure, the turn yields", async () => {
    let armed = false;
    let callerSpoke = false;
    const say = vas.realtimeScriptedSpeech(
      { generateReply: () => handleFake() },
      {
        observer: {
          arm: () => { armed = true; callerSpoke = false; },
          spoke: () => false, // the agent never got a frame out
          callerSpokeSinceArm: () => callerSpoke,
        },
        graceMs: 40,
      },
    );
    // the caller's transcript lands mid-grace, exactly as on the live call
    setTimeout(() => { callerSpoke = true; }, 10);
    // Since the delivery fix this path REPORTS what happened instead of returning void:
    // no audio ever framed, so the loop must not open this question's answer window —
    // `delivered: false, partial: false` is the "never voiced" signal the binding table
    // needs (voice-agent-session.test.ts V11).
    await expect(say(utterance)).resolves.toEqual({ delivered: false, partial: false });
    expect(armed).toBe(true);
  });

  // mutation: return `true` unconditionally from the grace check -> this test goes red.
  it("no audio + NO caller evidence still THROWS — the honesty property is intact", async () => {
    const say = vas.realtimeScriptedSpeech(
      { generateReply: () => handleFake() },
      {
        observer: {
          arm: () => {},
          spoke: () => false,
          callerSpokeSinceArm: () => false,
        },
        graceMs: 20,
      },
    );
    await expect(say(utterance)).rejects.toThrow(/silently failed/i);
  });

  it("an observer with no caller-evidence signal behaves exactly as before — throws", async () => {
    // Back-compat: the grace window is only consulted when the feed exists.
    const say = vas.realtimeScriptedSpeech(
      { generateReply: () => handleFake() },
      { observer: { arm: () => {}, spoke: () => false }, graceMs: 20 },
    );
    await expect(say(utterance)).rejects.toThrow(/silently failed/i);
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


describe("V9: say reports DELIVERY — the voiced-at time is the library's, never ours", () => {
  // The leak call's mechanism (touch `0fcf2180-…`): the loop stamped asked-at when it
  // CALLED say, but the model voiced the question later or never — so every caller turn
  // (all of which begin after the say call) bound to whatever question the loop thought
  // was open. The truthful timestamp exists inside the library: the realtime path
  // commits an assistant ChatMessage with `createdAt = startedSpeakingAt` (the first
  // real audio frame) and an `interrupted` flag when playout was cut short, reachable
  // via the public `SpeechHandle.chatItems` — and a speech that never framed commits NO
  // assistant item at all (installed 1.6.4 src, agent_activity.ts:3944–3968: the commit
  // is skipped without forwarded text).

  // mutation: stamp voicedAt from Date.now() instead of the chat item -> red (the pin's
  //           createdAt is a fixed epoch our clock can never produce).
  it("a completed turn reports delivered with the committed assistant item's createdAt", async () => {
    const session = {
      generateReply: () => ({
        waitForPlayout: () => Promise.resolve(),
        chatItems: [
          // the handle also carries non-assistant items; only the assistant MESSAGE
          // speaks for when OUR utterance was voiced
          { type: "function_call", createdAt: 1 },
          { type: "message", role: "user", createdAt: 2, interrupted: false },
          { type: "message", role: "assistant", createdAt: 111_222, interrupted: false },
        ],
      }),
    };
    const say = vas.realtimeScriptedSpeech(session, {
      observer: { arm: () => {}, spoke: () => true },
    });

    await expect(say("What budget range are you working with?")).resolves.toEqual({
      delivered: true,
      voicedAt: 111_222,
    });
  });

  // mutation: report a cut-off utterance as delivered -> red (the loop would open the
  //           answer window on a question the caller only half-heard, and never re-ask).
  it("an assistant item flagged interrupted reports partial — voiced, but cut off", async () => {
    const session = {
      generateReply: () => ({
        waitForPlayout: () => Promise.resolve(),
        chatItems: [{ type: "message", role: "assistant", createdAt: 333_444, interrupted: true }],
      }),
    };
    const say = vas.realtimeScriptedSpeech(session, {
      observer: { arm: () => {}, spoke: () => true },
    });

    await expect(say("Any must-haves?")).resolves.toEqual({
      delivered: false,
      partial: true,
      voicedAt: 333_444,
    });
  });

  it("no assistant item but audio DID leave -> the observer's first-frame time is the fallback", async () => {
    // The documented fallback: `createdAt` is typed optional on the structural seam, and
    // a feed that cannot surface chat items still knows when the room first heard audio.
    const session = {
      generateReply: () => ({ waitForPlayout: () => Promise.resolve() }),
    };
    const say = vas.realtimeScriptedSpeech(session, {
      observer: { arm: () => {}, spoke: () => true, firstFrameAt: () => 555_666 },
    });

    await expect(say("When are you hoping to move?")).resolves.toEqual({
      delivered: true,
      voicedAt: 555_666,
    });
  });
});

describe("V0c: the 2026-08-24 invention incident — the standing instruction whitelists, names the auto-reply moment, and bans the priors", () => {
  // 🔴 PROVEN ON A LIVE CALL (touch 2f7ecfae): 3.1 asked the owner "do you happen to
  // know your credit score range?" and "are you still thinking of selling your property
  // at 123 Main Street?" — questions `crm.questions` does not contain, voiced in
  // AUTO-REPLIES (model turns our loop never initiated). The old instruction's single
  // negative clause ("never invent questions") was the ALREADY-FAILED control: 3.1
  // invented in 4/4 dry-socket runs under it. The tight rewrite below went 0/4 with the
  // owner's deferral preserved (probe-invent findings, E3/E5). These pins hold the
  // load-bearing sentences; phrasing around them stays the model's (SETTLED: substance
  // not verbatim).
  it("whitelist framing, positively phrased: handed pieces are the ONLY questions", () => {
    // mutation: reword to the old "never invent" negative alone -> red.
    expect(INTAKE_INSTRUCTIONS).toMatch(/only questions you may ask/i);
  });

  it("the auto-reply moment is NAMED, with what the model may do there", () => {
    // The inventions all lived in the unnamed gap — caller speaks, nothing handed. The
    // instruction must name that moment and enumerate what is allowed in it.
    expect(INTAKE_INSTRUCTIONS).toMatch(/not been handed a new piece/i);
    expect(INTAKE_INSTRUCTIONS).toMatch(/acknowledge/i);
    expect(INTAKE_INSTRUCTIONS).toMatch(/pass (it|their question) along/i);
  });

  it("🔑 the surface-checkable rule: an acknowledgment never ends in a question mark", () => {
    // Stronger than "never invent questions" because the model can check it
    // mid-generation without classifying its own intent — declarative = reciprocity,
    // interrogative = invention (the probe's mechanical boundary, Q4).
    expect(INTAKE_INSTRUCTIONS).toMatch(/never ends in a question mark/i);
  });

  it("the banned categories are NAMED with examples — the priors 3.1 reaches for", () => {
    // credit, "123 Main Street", budget, buy-or-rent, consent-to-record: all US
    // telemarketing-script staples the model pattern-completes. Naming them beats the
    // generic prohibition that already failed.
    expect(INTAKE_INSTRUCTIONS).toMatch(/budget/i);
    expect(INTAKE_INSTRUCTIONS).toMatch(/address/i);
    expect(INTAKE_INSTRUCTIONS).toMatch(/credit/i);
    expect(INTAKE_INSTRUCTIONS).toMatch(/financing/i);
  });

  it("anti-silence permission: nothing handed means silence is CORRECT, not a problem to solve", () => {
    // Much invention is the model solving a problem we never told it wasn't a problem.
    expect(INTAKE_INSTRUCTIONS).toMatch(/silence between pieces is normal/i);
    expect(INTAKE_INSTRUCTIONS).toMatch(/saying nothing/i);
  });

  it("out-of-scope policy: don't have it, broker follows up, never guess", () => {
    expect(INTAKE_INSTRUCTIONS).toMatch(/broker will follow up/i);
    expect(INTAKE_INSTRUCTIONS).toMatch(/never guess/i);
  });

  it("AI disclosure: asked person-or-AI, it says AI assistant, directly", () => {
    expect(INTAKE_INSTRUCTIONS).toMatch(/AI assistant/);
  });

  it("opt-out: stop means acknowledge, confirm pass-on, and ask nothing further", () => {
    expect(INTAKE_INSTRUCTIONS).toMatch(/not to be contacted/i);
    expect(INTAKE_INSTRUCTIONS).toMatch(/nothing further/i);
  });

  it("length/format: one or two spoken sentences, never read out lists or formatting", () => {
    expect(INTAKE_INSTRUCTIONS).toMatch(/one or two/i);
    expect(INTAKE_INSTRUCTIONS).toMatch(/lists/i);
  });

  it("repeat ≠ new question: re-asking the SAME thing is allowed", () => {
    expect(INTAKE_INSTRUCTIONS).toMatch(/repeat/i);
    expect(INTAKE_INSTRUCTIONS).toMatch(/not a new question/i);
  });
});
