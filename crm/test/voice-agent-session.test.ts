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
// V11: `say` reports DELIVERY, and the binding table is built from when each question
//     was actually VOICED — not from when the loop handed it over. The 2026-08-22 leak
//     call (touch `0fcf2180-…`) proved the model frequently does NOT voice the handed
//     question at the say call — it finishes an interrupted sentence, acknowledges the
//     caller, drains its own backlog — while every caller turn necessarily starts after
//     the say CALL, so every utterance bound to whatever question the loop thought was
//     open: "how has your day been going?" was persisted as answered with "Uh", and the
//     owner's own complaint was stored as a lead's must-haves. The pins: a not-delivered
//     question is re-asked (bounded) and NOTHING ever binds to a never-voiced ordinal; a
//     turn that began between the hand-off and the voicing binds backward or drops; a
//     partial (cut-off) voicing may still be answered by a turn that began after it.
import { describe, it, expect } from "vitest";
import type { CallJobMetadata } from "../src/call-bridge.js";
import {
  runIntakeCall,
  ANSWER_WATCHDOG_MS,
  MAX_CONSECUTIVE_SILENCES,
  MAX_QUESTION_REASKS,
  type IntakeDeps,
  type SpeechDelivery,
  type TimedTranscript,
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
  // 🚨 The fake's voiced-at DIFFERS from the say-call clock on purpose (V11's vacuity
  // guard): a fake that reports "voiced exactly when handed over" would keep every pin
  // green even if the loop went back to stamping the say-call time — the exact defect
  // the delivery outcome exists to kill. These transcripts carry no turn times, so the
  // VALUE is inert here; the DIFFERENCE is the point.
  let voicedClock = 0;
  const deps: IntakeDeps = {
    session: {
      say: async (text) => {
        ops.push(`say:${text}`);
        voicedClock += 1_000;
        return { delivered: true, voicedAt: voicedClock + 250 };
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
 *  clock (simulating waited wall time). say() advances the clock 1s per utterance and
 *  reports the audio as having BEGUN 250ms after the hand-off — never AT it (the V11
 *  vacuity guard: a fake whose voiced-at equals the say-call time would vouch for the
 *  pre-fix stamping) — so each question's voiced-at is distinct and a test can place a
 *  turn precisely before or after it. */
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
        const voicedAt = clk.t + 250; // audio began AFTER the hand-off, never at it
        clk.t += 1_000;
        return { delivered: true, voicedAt };
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
      (clk) => ({ transcript: "around 8 million", turnStartedAt: clk.t }), // t=2000 ≥ voiced(1250)
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
        clk.t += 200; // q2's wait: an echo from q1's window (q1 voiced 1250, q2 voiced 2250)
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
        clk.t += 100; // q1's wait: the opening-line reply lands (turn began t=400 < q1 voiced t=1250)
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

// ═══ V11: DELIVERY-OUTCOME BINDING (the 2026-08-22 leak-call fix) ═══════════════════════
//
// The proven defect, from the persisted rows of touch `0fcf2180-…`: `askedAt[i]` was
// stamped BEFORE `say`, but the model frequently voices the handed question seconds
// later or never — so "how has your day been going?" was answered with "Uh", and the
// owner's complaint ("I'm not giving the answer to questions…") was stored as a lead's
// must-haves. `say` now reports DELIVERY (`SpeechDelivery`), the binding table holds
// VOICED times, a not-delivered question is re-asked (bounded by MAX_QUESTION_REASKS),
// and a never-voiced ordinal can never receive an answer.

/** The V11 seam: say outcomes are scripted per call (and may queue caller turns, the way
 *  a barge-in leaves a final transcript behind), and nextFinalTranscript distinguishes a
 *  DRAIN (timeout 0: only what is already queued) from an answer WINDOW (timeout > 0:
 *  queued turns first, then the window script) — the same contract the worker's queue
 *  implements over `conversation_item_added`. */
function deliveryFakeDeps(opts: {
  says: Array<(clk: { t: number }, queue: TimedTranscript[]) => SpeechDelivery>;
  windows: Array<(clk: { t: number }) => TimedTranscript | string | null>;
}) {
  const clk = { t: 0 };
  const queue: TimedTranscript[] = [];
  const ops: string[] = [];
  let s = 0;
  let w = 0;
  const deps: IntakeDeps = {
    session: {
      say: async (text) => {
        ops.push(`say:${text}`);
        const step = opts.says[s++];
        if (!step) throw new Error(`unscripted say #${s}: ${text}`);
        const out = step(clk, queue);
        clk.t += 1_000;
        return out;
      },
      nextFinalTranscript: async (timeoutMs) => {
        const queued = queue.shift();
        if (queued !== undefined) return queued;
        if (timeoutMs <= 0) return null; // a DRAIN sees only what already arrived
        const step = opts.windows[w++];
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
  return { deps, ops };
}

/** The normal outcome: audio began 250ms after the hand-off — never AT it. */
const voiced = (clk: { t: number }): SpeechDelivery => ({
  delivered: true,
  voicedAt: clk.t + 250,
});
/** The silent-return barge-in outcome: no audio at all, caller evidence in the grace
 *  window — the question was never voiced. */
const notDelivered = (): SpeechDelivery => ({ delivered: false, partial: false });

const says = (ops: string[], text: string) => ops.filter((o) => o === `say:${text}`);

describe("V11: a not-delivered question is re-asked, and its ordinal receives NOTHING", () => {
  // mutation: stamp askedAt from the say-call clock (the pre-fix shape) -> the queued
  //           turn lands on q2, the never-voiced ordinal.
  it("a caller turn queued behind a failed delivery binds to the prior VOICED question — never to the ordinal that was never voiced", async () => {
    const { deps, ops } = deliveryFakeDeps({
      says: [
        voiced, // opening
        voiced, // q1 — voiced 1250, then silence (its answer arrives late, below)
        (clk, queue) => {
          // q2's turn NEVER frames: the caller was already talking (turn began t=5000,
          // well after q1 was voiced) — exactly the shape that filed "My day's been
          // gone pretty good" under "what kind of property?" on the leak call.
          queue.push({ transcript: "we're pre-approved up to 9 million", turnStartedAt: 5_000 });
          return notDelivered();
        },
        voiced, // q2's re-ask lands normally
      ],
      windows: [
        () => null, // q1's window: watchdog silence (the answer is still generating)
        (clk) => ({ transcript: "before Christmas", turnStartedAt: clk.t }),
      ],
    });

    const report = await runIntakeCall(JOB, "human", deps);

    // The straggler files against q1 — the question that was VOICED and unanswered when
    // the turn began — and q2 gets only its own post-re-ask answer.
    expect(ops.filter((o) => o.startsWith("persist:"))).toEqual([
      "persist:q1:we're pre-approved up to 9 million",
      "persist:q2:before Christmas",
    ]);
    expect(ops).not.toContain("persist:q2:we're pre-approved up to 9 million");
    expect(says(ops, "When are you hoping to move?")).toHaveLength(2); // asked, re-asked
    expect(report.answersPersisted).toBe(2);
    expect(report.conversation).toBe("identity_not_asked_complete");
  });

  it("a queued turn from before ANY voiced question is dropped on the drain — never held for the re-ask", async () => {
    const { deps, ops } = deliveryFakeDeps({
      says: [
        voiced, // opening
        (clk, queue) => {
          // q1 never frames; the queued turn began at t=300 — before anything was voiced
          queue.push({ transcript: "hello? hello?", turnStartedAt: 300 });
          return notDelivered();
        },
        voiced, // q1's re-ask
        voiced, // q2
      ],
      windows: [
        (clk) => ({ transcript: "around 8 million", turnStartedAt: clk.t }),
        (clk) => ({ transcript: "before Christmas", turnStartedAt: clk.t }),
      ],
    });

    const report = await runIntakeCall(JOB, "human", deps);

    expect(ops.join("|")).not.toContain("hello? hello?");
    expect(ops.filter((o) => o.startsWith("persist:"))).toEqual([
      "persist:q1:around 8 million",
      "persist:q2:before Christmas",
    ]);
    expect(says(ops, "What budget range are you working with?")).toHaveLength(2);
    expect(report.conversation).toBe("identity_not_asked_complete");
  });
});

describe("V11: a turn that began between the hand-off and the voicing does NOT bind to the open question", () => {
  // THE "Uh" CASE, verbatim from the leak call: the loop handed q1 over at t=1000, the
  // model spent 250ms acknowledging before the question's audio began (t=1250), and the
  // caller's filler ("Uh") started at t=1100 — a reply to the MODEL'S chatter, not to a
  // question nobody had heard yet. Stamped at the say call it binds to q1; stamped at
  // the voicing it binds to nothing.
  // mutation: askedAt[i] from the say-call clock -> "Uh" persists under q1.
  it('"Uh" (turn began before the question was voiced) is dropped; the real answer binds', async () => {
    const { deps, ops } = deliveryFakeDeps({
      says: [voiced, voiced, voiced], // opening, q1 (voiced 1250), q2
      windows: [
        () => ({ transcript: "Uh", turnStartedAt: 1_100 }), // hand-off 1000 < 1100 < voiced 1250
        (clk) => ({ transcript: "around 8 million", turnStartedAt: clk.t }), // ≥ 1250
        (clk) => ({ transcript: "before Christmas", turnStartedAt: clk.t }),
      ],
    });

    const report = await runIntakeCall(JOB, "human", deps);

    expect(ops.join("|")).not.toContain("Uh");
    expect(ops.filter((o) => o.startsWith("persist:"))).toEqual([
      "persist:q1:around 8 million",
      "persist:q2:before Christmas",
    ]);
    expect(report.conversation).toBe("identity_not_asked_complete");
  });
});

describe("V11: re-asks are bounded — exhaustion is ONE silence, and the report stays honest", () => {
  // mutation: re-ask forever -> this test hangs (the unscripted-say throw catches it);
  // mutation: count each failed delivery as its own silence -> q2 is never asked.
  it("three failed deliveries on q1 = the ask + MAX_QUESTION_REASKS, ONE silence, q2 still asked, report cut_off", async () => {
    const { deps, ops } = deliveryFakeDeps({
      says: [
        voiced, // opening
        notDelivered, // q1 hand-off never voiced…
        notDelivered, // …re-ask 1…
        notDelivered, // …re-ask 2 — exhausted
        voiced, // q2 proceeds: exhaustion counted ONE silence, not two
      ],
      windows: [(clk) => ({ transcript: "before Christmas", turnStartedAt: clk.t })],
    });

    const report = await runIntakeCall(JOB, "human", deps);

    expect(MAX_QUESTION_REASKS).toBe(2);
    expect(says(ops, "What budget range are you working with?")).toHaveLength(
      1 + MAX_QUESTION_REASKS,
    );
    // ONE silence for the whole exhausted ordinal — a second would have ended the call
    // (MAX_CONSECUTIVE_SILENCES = 2) before q2 was ever asked.
    expect(says(ops, "When are you hoping to move?")).toHaveLength(1);
    expect(ops.filter((o) => o.startsWith("persist:"))).toEqual([
      "persist:q2:before Christmas",
    ]);
    // q1 was never voiced and never answered: the claim is cut_off, never a fabricated
    // complete — and the call ended by OUR bookkeeping, not a hang.
    expect(report.conversation).toBe("identity_not_asked_cut_off");
    expect(report.answersPersisted).toBe(1);
    expect(report.reachedOrdinal).toBe(2);
  });
});

describe("V11: a PARTIAL voicing (cut off mid-question) keeps its voiced time", () => {
  // mutation: treat partial as never-voiced -> the post-voicing answer is dropped and
  //           q1 is pointlessly re-asked; mutation: askedAt from the say call -> the
  //           mid-generation noise persists under q1.
  it("a turn that began AFTER the partial voicing answers it — one that began before drops — no re-ask needed", async () => {
    const { deps, ops } = deliveryFakeDeps({
      says: [
        voiced, // opening
        (clk, queue) => {
          // q1's audio began (t=1250) but was cut off; the caller had started filler at
          // t=1100 (before the voicing — binds to nothing) and then answered at t=1600
          // (after it — an answer to the question they heard begin).
          queue.push({ transcript: "sorry, go ahead", turnStartedAt: 1_100 });
          queue.push({ transcript: "around 8 million", turnStartedAt: 1_600 });
          return { delivered: false, partial: true, voicedAt: clk.t + 250 };
        },
        voiced, // q2
      ],
      windows: [(clk) => ({ transcript: "before Christmas", turnStartedAt: clk.t })],
    });

    const report = await runIntakeCall(JOB, "human", deps);

    expect(ops.join("|")).not.toContain("sorry, go ahead");
    expect(ops.filter((o) => o.startsWith("persist:"))).toEqual([
      "persist:q1:around 8 million",
      "persist:q2:before Christmas",
    ]);
    // The caller already answered the cut-off question — re-asking it would be the IVR
    // loop the owner refuses to ship.
    expect(says(ops, "What budget range are you working with?")).toHaveLength(1);
    expect(report.conversation).toBe("identity_not_asked_complete");
  });

  it("a partial with no answer after its voicing IS re-asked — and the earliest voiced time keeps binding", async () => {
    const { deps, ops } = deliveryFakeDeps({
      says: [
        voiced, // opening
        (clk, queue) => {
          // cut off with only PRE-voicing speech on the queue (the opening-line reply)
          queue.push({ transcript: "yes, speaking", turnStartedAt: 400 });
          return { delivered: false, partial: true, voicedAt: clk.t + 250 };
        },
        voiced, // the re-ask delivers
        voiced, // q2
      ],
      windows: [
        // The answer's turn began at the current clock — after the FIRST (partial)
        // voicing, which is the time that must keep binding.
        (clk) => ({ transcript: "around 8 million", turnStartedAt: clk.t }),
        (clk) => ({ transcript: "before Christmas", turnStartedAt: clk.t }),
      ],
    });

    const report = await runIntakeCall(JOB, "human", deps);

    expect(ops.join("|")).not.toContain("yes, speaking");
    expect(says(ops, "What budget range are you working with?")).toHaveLength(2);
    expect(ops.filter((o) => o.startsWith("persist:"))).toEqual([
      "persist:q1:around 8 million",
      "persist:q2:before Christmas",
    ]);
    expect(report.conversation).toBe("identity_not_asked_complete");
  });
});

describe("V11: the leak call, replayed — zero commits against never-voiced ordinals", () => {
  // The timeline of touch `0fcf2180-…`, reconstructed from its persisted rows: the model
  // voiced q1 late (after draining its own backlog), never voiced q2 on the hand-off
  // (it was busy being acknowledged), and never voiced q3/q4 at all while the caller
  // kept talking — filler, a late real answer, noise, and finally the owner's complaint.
  // The OLD loop persisted: q1="Uh", q2=the answer to q1, q3=noise, q4=the complaint.
  // mutation (THE proving one): revert `askedAt[i] = <voiced time>` to the say-call
  //          clock -> "Uh" binds to q1 again and this test goes red.
  const REPLAY_JOB: CallJobMetadata = {
    ...JOB,
    prompts: [
      { id: "qday", questionKey: "rapport", promptText: "How has your day been going?" },
      { id: "qprop", questionKey: "property", promptText: "What kind of property are you looking for?" },
      { id: "qbud", questionKey: "budget", promptText: "What budget range are you working with?" },
      { id: "qmust", questionKey: "musts", promptText: "Any must-haves?" },
    ],
  };

  it("every caller turn lands on the question that was VOICED when it began — or nowhere", async () => {
    const { deps, ops } = deliveryFakeDeps({
      says: [
        voiced, // opening
        // qday handed over at t=1000; the model acknowledged first and the question's
        // audio only began at t=3500 — delivered, but LATE.
        (clk) => ({ delivered: true, voicedAt: clk.t + 2_500 }),
        (clk, queue) => {
          // qprop never frames: the caller was mid-answer to qday (turn began t=4000,
          // after qday's late voicing) — the turn the old loop filed under qprop.
          queue.push({
            transcript: "My day's been going pretty good. How about yours?",
            turnStartedAt: 4_000,
          });
          return notDelivered();
        },
        voiced, // qprop's re-ask delivers
        (clk, queue) => {
          // qbud never frames, three times over, while cross-talk noise arrives —
          // its turn began after qprop was voiced AND answered, so it belongs nowhere.
          queue.push({ transcript: "我一定要", turnStartedAt: clk.t });
          return notDelivered();
        },
        notDelivered, // qbud re-ask 1
        notDelivered, // qbud re-ask 2 — exhausted, one silence
        (clk, queue) => {
          // qmust never frames either; the owner's complaint arrives — the row the old
          // loop persisted as a lead's must-haves.
          queue.push({
            transcript: "I'm not giving the answer to questions, I'm asking why you're calling.",
            turnStartedAt: clk.t,
          });
          return notDelivered();
        },
        notDelivered, // qmust re-ask 1
        notDelivered, // qmust re-ask 2 — exhausted, second silence, end of script
      ],
      windows: [
        // qday's answer window: the caller's filler began at t=1200 — BEFORE qday's
        // late voicing at 3500 — a reply to the model's chatter, not to the question.
        () => ({ transcript: "Uh", turnStartedAt: 1_200 }),
        () => null, // then watchdog silence (qday's real answer is still generating)
        // qprop's post-re-ask window: a real answer, begun after the re-ask's voicing
        (clk) => ({ transcript: "a two-bedroom condo in Makati", turnStartedAt: clk.t }),
      ],
    });

    const report = await runIntakeCall(REPLAY_JOB, "human", deps);

    // The two rows that are TRUE — the late answer re-bound to the question it answers,
    // and the re-asked question's own answer — and NOTHING else. In particular: zero
    // commits against qbud and qmust, the ordinals whose audio never existed.
    expect(ops.filter((o) => o.startsWith("persist:"))).toEqual([
      "persist:qday:My day's been going pretty good. How about yours?",
      "persist:qprop:a two-bedroom condo in Makati",
    ]);
    expect(ops.join("|")).not.toContain("persist:qday:Uh");
    expect(ops.filter((o) => o.startsWith("persist:qbud"))).toEqual([]);
    expect(ops.filter((o) => o.startsWith("persist:qmust"))).toEqual([]);
    expect(ops.join("|")).not.toContain("我一定要");
    expect(ops.join("|")).not.toContain("not giving the answer");

    // And the report is the honest one: 2 of 4 answered, cut_off — never the
    // normal-shaped `complete` the earlier call (touch `8b40d0d1-…`) faked while being
    // off-by-one throughout.
    expect(report).toEqual({
      v: 1,
      amdResult: "human",
      conversation: "identity_not_asked_cut_off",
      answersPersisted: 2,
      reachedOrdinal: 2,
    });
  });
});
