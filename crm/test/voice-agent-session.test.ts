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
