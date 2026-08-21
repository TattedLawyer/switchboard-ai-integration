// Voice-agent session pins — the SCRIPTED INTAKE the worker runs, tested here because the
// worker's entry (`voice-agent/worker.ts`) sits outside every tsconfig, exactly like the
// executor loop: ALL testable logic lives in `crm/src/voice-agent-session.ts` and the
// worker imports it thinly. A real bug shipped in the loop because no typecheck ever saw
// it; this module never gets that chance.
//
// V1: the script — opening line VERBATIM, then each approved question in order, ONE AT A
//     TIME, each answer persisted THE MOMENT it is final (stream, never buffer — and the
//     guard for agents-js #2157, whose teardown race can skip shutdown callbacks
//     entirely: nothing here waits for shutdown).
// V2: the per-turn watchdog — a silent question advances the script instead of hanging it
//     (guard for agents-js #2108's gone-silent failure mode: the call ends by OUR clock,
//     not by the caller's patience).
// V3: two consecutive silences mean the caller is gone — stop asking a dead line.
// V4: a machine answer runs NO questionnaire — raw `machine` reported, room deleted.
// V5: `uncertain` proceeds (a human may be there) but is REPORTED as `unknown`, verbatim —
//     never laundered to `human` (disposition.ts's pinned trap).
// V6: the report is published BEFORE the hangup — deleting the room first would tear down
//     the metadata channel the transport is polling.
// V7: a mid-call death propagates — no report is fabricated (transport rule 2 end-to-end),
//     and the answers already persisted STAND.
// V8: answers are bound by TURN-START time, never by arrival order — the Google plugin
//     emits the final transcript only after the model's reply finishes generating
//     ("seconds after the user spoke", realtime_api.js verbatim), so a straggler
//     consumed FIFO would be persisted under the FOLLOWING question's id. A transcript
//     whose turn began before the current question was asked belongs to the question
//     that was open then: filed there if it is still unanswered, DROPPED otherwise —
//     never misfiled.
// V9: a transcript with no usable turn time is accepted for the OPEN question — the
//     documented conservative fallback (upstream `turnStartedAt` is optional; a provider
//     that omits it degrades to arrival order, exactly the pre-fix behaviour, never
//     worse — dropping would kill every intake on such a provider).
// V10: a turn that began before ANY question was asked (AMD-window speech, the reply to
//     the opening line) is dropped — this subsumes and widens the worker's old
//     drop-stale point, which cleared only what AMD consumed.
import { describe, it, expect } from "vitest";
import type { CallJobMetadata } from "../src/call-bridge.js";
import {
  runIntakeCall,
  ANSWER_WATCHDOG_MS,
  MAX_CONSECUTIVE_SILENCES,
  type IntakeDeps,
} from "../src/voice-agent-session.js";

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

/** A scripted callee plus an ordered op log. `transcripts` are consumed one per question;
 *  `null` is a watchdog-expired silence; a function throws mid-call. */
function fakeDeps(transcripts: Array<string | null | (() => never)>): {
  deps: IntakeDeps;
  ops: string[];
  watchdogsSeen: number[];
} {
  const ops: string[] = [];
  const watchdogsSeen: number[] = [];
  let i = 0;
  const deps: IntakeDeps = {
    session: {
      say: async (text) => {
        ops.push(`say:${text}`);
      },
      nextFinalTranscript: async (timeoutMs) => {
        watchdogsSeen.push(timeoutMs);
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
  return { deps, ops, watchdogsSeen };
}

describe("V1: the script — verbatim opening, ordered questions, per-turn persistence", () => {
  // mutation: buffer answers in an array and flush persistAnswer/reached at hang-up
  //           (the #2157 anti-pattern) -> red. RUN ✅ 2026-08-19
  //   Observed: `Tests  2 failed | 8 passed (10)`
  //     AssertionError: expected [ …(9) ] to deeply equal [ …(9) ] (persist/reached moved
  //     after the report) · expected [ …(3) ] to include 'persist:q1:around 8 million'
  //     (V7: the mid-call death now loses the buffered answer)
  it("speaks her approved words, asks one question at a time, persists each answer as it arrives", async () => {
    const { deps, ops, watchdogsSeen } = fakeDeps(["around 8 million", "before Christmas"]);

    const report = await runIntakeCall(JOB, "human", deps);

    expect(ops).toEqual([
      "say:Hi, may I speak with Ana Reyes?",
      "say:What budget range are you working with?",
      // Persisted BEFORE the next question is even asked — a death after this line loses
      // nothing she already said.
      "persist:q1:around 8 million",
      "reached:1",
      "say:When are you hoping to move?",
      "persist:q2:before Christmas",
      "reached:2",
      "report:human:identity_not_asked_complete",
      "hangUp",
    ]);
    // The watchdog is the declared constant, handed to the session on every turn.
    expect(watchdogsSeen).toEqual([ANSWER_WATCHDOG_MS, ANSWER_WATCHDOG_MS]);

    // The RAW report: this scripted worker performs NO identity determination (zero tools
    // — the guard for agents-js #2249 — leaves it no way to report one), so it claims
    // `identity_not_asked_*`, never `identity_confirmed_*`. disposition.ts maps that to
    // answered/partial WITH identity_unverified = true — honest, not optimistic.
    expect(report).toEqual({
      v: 1,
      amdResult: "human",
      conversation: "identity_not_asked_complete",
      answersPersisted: 2,
      reachedOrdinal: 2,
    });
  });
});

describe("V2: the per-turn watchdog advances past silence", () => {
  // mutation: persist a silent turn as an answer (`transcript ?? ""`, condition
  //           short-circuited true) -> red. RUN ✅ 2026-08-19
  //   Observed: `Tests  3 failed | 7 passed (10)`
  //     AssertionError: expected [ 'persist:q1:   ', …(1) ] to deeply equal
  //     [ 'persist:q2:before Christmas' ]
  it("a silent question is skipped — nothing persisted for it, the next one is asked", async () => {
    const { deps, ops } = fakeDeps([null, "before Christmas"]);

    const report = await runIntakeCall(JOB, "human", deps);

    // q1 got silence: no persist, no reached; q2 was still asked and captured.
    expect(ops).toEqual([
      "say:Hi, may I speak with Ana Reyes?",
      "say:What budget range are you working with?",
      "say:When are you hoping to move?",
      "persist:q2:before Christmas",
      "reached:2",
      "report:human:identity_not_asked_cut_off",
      "hangUp",
    ]);
    // Not every question was answered, so the honest claim is cut_off (-> `partial`
    // downstream, decided by disposition.ts, not here).
    expect(report.conversation).toBe("identity_not_asked_cut_off");
    expect(report.answersPersisted).toBe(1);
    expect(report.reachedOrdinal).toBe(2);
  });

  it("whitespace-only transcription is silence, not an answer", async () => {
    const { deps, ops } = fakeDeps(["   ", "before Christmas"]);

    await runIntakeCall(JOB, "human", deps);

    expect(ops.filter((o) => o.startsWith("persist:"))).toEqual([
      "persist:q2:before Christmas",
    ]);
  });
});

describe("V3: consecutive silences end the call — a dead line is not interrogated", () => {
  // mutation: delete the MAX_CONSECUTIVE_SILENCES break -> red. RUN ✅ 2026-08-19
  //   Observed: `Tests  1 failed | 9 passed (10)`
  //     AssertionError: expected 4 to be 3 // Object.is equality (q3 was asked into the
  //     dead line)
  it("stops after MAX_CONSECUTIVE_SILENCES and never asks the rest", async () => {
    const threeQuestions: CallJobMetadata = {
      ...JOB,
      prompts: [
        ...JOB.prompts,
        { id: "q3", questionKey: "area", promptText: "Which areas are you considering?" },
      ],
    };
    const { deps, ops } = fakeDeps([null, null, "never reached"]);

    const report = await runIntakeCall(threeQuestions, "human", deps);

    expect(MAX_CONSECUTIVE_SILENCES).toBe(2);
    // q3 was never asked: two questions in a row into silence means nobody is there.
    expect(ops.filter((o) => o.startsWith("say:")).length).toBe(3); // opening + q1 + q2
    expect(ops.filter((o) => o.startsWith("persist:"))).toEqual([]);
    expect(report).toEqual({
      v: 1,
      amdResult: "human",
      conversation: "identity_not_asked_cut_off",
      answersPersisted: 0,
      reachedOrdinal: 0,
    });
  });
});

describe("V4: a machine gets no questionnaire", () => {
  // mutation: say the opening line on the machine path -> red. RUN ✅ 2026-08-19
  //   Observed: `Tests  2 failed | 8 passed (10)`
  //     AssertionError: expected [ …(3) ] to deeply equal [ 'report:machine:null',
  //     'hangUp' ]
  it.each([["machine-vm"], ["machine-unavailable"]] as const)(
    "%s: nothing is spoken, raw machine is reported, the room is deleted",
    async (category) => {
      const { deps, ops } = fakeDeps([]);

      const report = await runIntakeCall(JOB, category, deps);

      // No opening line into a voicemail box: no message is left in Wave 1 (deferred —
      // `messageLeft` stays false via executeCall's default), and reciting her approved
      // opening to a recording is not an intake.
      expect(ops).toEqual(["report:machine:null", "hangUp"]);
      expect(report.amdResult).toBe("machine");
      expect(report.conversation).toBeNull();
    },
  );
});

describe("V5: uncertain proceeds but is REPORTED as unknown — never laundered", () => {
  // mutation: hardcode `amdResult: "human"` in the published report -> red.
  //           RUN ✅ 2026-08-19
  //   Observed: `Tests  1 failed | 9 passed (10)`
  //     AssertionError: expected 'human' to be 'unknown' // Object.is equality
  it("runs the script (a human may be there) and reports amdResult unknown verbatim", async () => {
    const { deps, ops } = fakeDeps(["around 8 million", "before Christmas"]);

    const report = await runIntakeCall(JOB, "uncertain", deps);

    // The intake ran — hanging up on a possible human is worse than asking.
    expect(ops.filter((o) => o.startsWith("persist:")).length).toBe(2);
    // But the signal stays honest: disposition.ts resolves 200+unknown to
    // `unknown_answer`, and that is ITS call to make, not this worker's.
    expect(report.amdResult).toBe("unknown");
    expect(report.amdResult).not.toBe("human");
  });

  it("machine-ivr is treated like a human — the script runs and reports human", async () => {
    const { deps } = fakeDeps(["around 8 million", "before Christmas"]);
    const report = await runIntakeCall(JOB, "machine-ivr", deps);
    expect(report.amdResult).toBe("human");
  });
});

describe("V6: report BEFORE hangup, always", () => {
  // mutation: hangUp before publishReport -> red. RUN ✅ 2026-08-19
  //   Observed: `Tests  3 failed | 7 passed (10)`
  //     AssertionError: expected 7 to be 8 (hangUp is no longer the last op; the report
  //     went onto a deleted room)
  it("the report is on the wire before the room dies, on every completed path", async () => {
    for (const transcripts of [
      ["a", "b"],
      [null, null],
    ] as Array<Array<string | null>>) {
      const { deps, ops } = fakeDeps(transcripts);
      await runIntakeCall(JOB, "human", deps);
      const reportAt = ops.findIndex((o) => o.startsWith("report:"));
      const hangUpAt = ops.indexOf("hangUp");
      expect(reportAt).toBeGreaterThanOrEqual(0);
      expect(hangUpAt).toBe(ops.length - 1);
      expect(reportAt).toBeLessThan(hangUpAt);
    }
  });
});

describe("V7: a mid-call death is honest — answers stand, no report is fabricated", () => {
  // mutation: try/catch around nextFinalTranscript, treating the death as silence and
  //           finishing normally -> red. RUN ✅ 2026-08-19
  //   Observed: `Tests  1 failed | 9 passed (10)`
  //     AssertionError: promise resolved "{ v: 1, amdResult: 'human', …(3) }" instead of
  //     rejecting
  it("propagates the failure after the first answer was already persisted", async () => {
    const { deps, ops } = fakeDeps([
      "around 8 million",
      () => {
        throw new Error("the session died mid-question");
      },
    ]);

    await expect(runIntakeCall(JOB, "human", deps)).rejects.toThrow(/died mid-question/);

    // What she said before the line dropped is TRUE and already committed (rule 1); what
    // never happened is not reported (rule 2) — the transport times out on the missing
    // report and throws, leaving the proposal visibly `executing` for reconcile.
    expect(ops).toContain("persist:q1:around 8 million");
    expect(ops.filter((o) => o.startsWith("report:"))).toEqual([]);
  });
});

// ═══ V8–V10: TURN-START BINDING (the late-transcript fix) ═══════════════════════════════

/** Like fakeDeps, but the seam carries TIMED transcripts and the loop's clock is OURS:
 *  each script entry runs when the loop asks for the next transcript and may advance the
 *  clock (simulating waited wall time). say() advances the clock 1s per utterance, so
 *  each question's asked-at is distinct and a test can place a turn precisely before or
 *  after it. */
function timedFakeDeps(
  script: Array<
    (clk: { t: number }) => { transcript: string; turnStartedAt?: number } | string | null
  >,
) {
  const clk = { t: 0 };
  const ops: string[] = [];
  let i = 0;
  const deps: IntakeDeps = {
    session: {
      say: async (text) => {
        ops.push(`say:${text}`);
        clk.t += 1_000;
      },
      nextFinalTranscript: async () => {
        const step = script[i++];
        return step ? step(clk) : null;
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
    now: () => clk.t,
  };
  return { deps, ops, clk };
}

describe("V8: a late transcript is bound by turn-start time — never filed against the NEXT question", () => {
  // THE CANONICAL CASE. Timeline (clock in ms, say() costs 1s):
  //   t=0     opening spoken (ends t=1000)
  //   t=1000  q1 asked (ends t=2000); the caller STARTS answering at t=3000
  //   the transcript has not arrived yet (the plugin holds finals until its reply
  //   finishes generating) -> q1's watchdog expires
  //   t=17000 q2 asked (ends t=18000)
  //   t=18500 q1's straggler finally arrives, turnStartedAt=3000 — BEFORE q2 was asked
  // FIFO would persist it under q2 (silent data corruption). Turn-start binding files it
  // under q1.
  // mutation: accept every transcript for the current question (drop the askedAt
  //           comparison — the pre-fix FIFO) -> red. RUN ✅ 2026-08-21 (grep-confirmed):
  //           `Tests  3 failed | 12 passed (15)` — this test, the stale-duplicate
  //           test, and the V10 opening-line test.
  it("q1's straggler arriving during q2's wait persists against q1 — and NEVER against q2", async () => {
    const { deps, ops } = timedFakeDeps([
      (clk) => {
        clk.t += ANSWER_WATCHDOG_MS; // q1: nothing arrives inside the watchdog
        return null;
      },
      (clk) => {
        clk.t += 500; // q2's wait: the straggler lands…
        return { transcript: "around 8 million", turnStartedAt: 3_000 }; // …from q1's turn
      },
      (clk) => {
        clk.t += ANSWER_WATCHDOG_MS; // then q2 itself gets silence
        return null;
      },
    ]);

    const report = await runIntakeCall(JOB, "human", deps);

    expect(ops.filter((o) => o.startsWith("persist:"))).toEqual([
      "persist:q1:around 8 million",
    ]);
    expect(ops).not.toContain("persist:q2:around 8 million");
    expect(report.answersPersisted).toBe(1);
    expect(report.reachedOrdinal).toBe(1);
    // q2 was asked and got silence — not every question answered, so the honest claim:
    expect(report.conversation).toBe("identity_not_asked_cut_off");
  });

  it("in-order answers with turn times still flow exactly as before", async () => {
    const { deps, ops } = timedFakeDeps([
      (clk) => ({ transcript: "around 8 million", turnStartedAt: clk.t }), // t=2000 ≥ asked(1000)
      (clk) => ({ transcript: "before Christmas", turnStartedAt: clk.t }),
    ]);

    const report = await runIntakeCall(JOB, "human", deps);

    expect(ops).toEqual([
      "say:Hi, may I speak with Ana Reyes?",
      "say:What budget range are you working with?",
      "persist:q1:around 8 million",
      "reached:1",
      "say:When are you hoping to move?",
      "persist:q2:before Christmas",
      "reached:2",
      "report:human:identity_not_asked_complete",
      "hangUp",
    ]);
    expect(report.answersPersisted).toBe(2);
    expect(report.reachedOrdinal).toBe(2);
  });

  // mutation: file a stale transcript against its earlier question even when that
  //           question already has an answer -> red. RUN ✅ 2026-08-21 (grep-confirmed):
  //           `Tests  1 failed | 14 passed (15)`.
  it("a stale duplicate whose question is already answered is DROPPED — never misfiled anywhere", async () => {
    const { deps, ops } = timedFakeDeps([
      (clk) => ({ transcript: "around 8 million", turnStartedAt: clk.t }), // q1 answered
      (clk) => {
        clk.t += 200; // q2's wait: an echo from q1's window (asked t=1000, q2 asked t=2000)
        return { transcript: "eight million I said", turnStartedAt: 1_500 };
      },
      (clk) => ({ transcript: "before Christmas", turnStartedAt: clk.t }), // q2's real answer
    ]);

    const report = await runIntakeCall(JOB, "human", deps);

    expect(ops.filter((o) => o.startsWith("persist:"))).toEqual([
      "persist:q1:around 8 million",
      "persist:q2:before Christmas",
    ]);
    expect(report.answersPersisted).toBe(2);
    expect(report.conversation).toBe("identity_not_asked_complete");
  });
});

describe("V9: a transcript with no usable turn time goes to the OPEN question — the documented fallback", () => {
  it("an untimed object and a bare-string transcript are both accepted for the question being waited on", async () => {
    const { deps, ops } = timedFakeDeps([
      () => ({ transcript: "around 8 million" }), // provider omitted turnStartedAt
      () => "before Christmas", // legacy bare-string seam shape
    ]);

    const report = await runIntakeCall(JOB, "human", deps);

    expect(ops.filter((o) => o.startsWith("persist:"))).toEqual([
      "persist:q1:around 8 million",
      "persist:q2:before Christmas",
    ]);
    expect(report.conversation).toBe("identity_not_asked_complete");
  });
});

describe("V10: a turn that began before ANY question is dropped — the drop-stale point, subsumed and widened", () => {
  // The worker used to clear its queue once, after the AMD verdict — which missed the
  // eager "yes, speaking" reply to the OPENING line (its final lands during q1's wait
  // and FIFO filed it under q1; the worker header called this out as an open tuning
  // hazard). Binding by turn-start closes it: the opening is not a question, so a turn
  // from before q1 was asked binds to nothing.
  // mutation: bind pre-question turns to question 1 -> red.
  it("the reply to the opening line is not an answer to question 1", async () => {
    const { deps, ops } = timedFakeDeps([
      (clk) => {
        clk.t += 100; // q1's wait: the opening-line reply lands (turn began t=400 < q1 asked t=1000)
        return { transcript: "yes, speaking", turnStartedAt: 400 };
      },
      (clk) => ({ transcript: "around 8 million", turnStartedAt: clk.t }), // q1's real answer
      (clk) => ({ transcript: "before Christmas", turnStartedAt: clk.t }),
    ]);

    const report = await runIntakeCall(JOB, "human", deps);

    expect(ops.filter((o) => o.startsWith("persist:"))).toEqual([
      "persist:q1:around 8 million",
      "persist:q2:before Christmas",
    ]);
    expect(ops.join("|")).not.toContain("yes, speaking");
    expect(report.answersPersisted).toBe(2);
    expect(report.reachedOrdinal).toBe(2);
    expect(report.conversation).toBe("identity_not_asked_complete");
  });
});
