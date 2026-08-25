// CallerEnergyEvidence pins (E1–E8) — Fix A, 2026-08-24: energy becomes SECONDARY
// caller evidence. The live call this fixes (fix-25, room call-97e26350): the owner was
// TALKING — the meter measured him at rms 0.0511 (w188, clear) inside answer window 3
// and 0.0905/0.0516 (w237 playout 0.73 / w238 clear) inside answer window 4 — and the
// system counted BOTH windows as silence ("countedSilence":true at +67580 and +86797)
// and hung up on him at 2 answers of 10, because nothing consulted the meter.
//
// THE RULE (live-calibrated, n=2 calls): a window QUALIFIES when rms >= 0.02 AND
// !duringPlayout; evidence fires at 2 CONSECUTIVE qualifying windows. A speech-loud
// window DURING playout (>=0.5 playout fraction) is ambiguous — caller-over-agent or
// line echo — so it neither counts nor resets the run (HOLD); a quiet window RESETS.
// Calibration basis: caller speech measured 0.034–0.172 rms on this trunk, quiet floor
// <=0.0017, during-playout echo <=0.0008 — 0.02 is ~12x above the floor and ~1.7x below
// the softest observed speech. Confidence is high on THIS trunk and moderate across
// carriers, hence both numbers are injectable options with exported defaults (the
// worker reads env at its edge and injects — this module never reads process.env).
//
// THE EVIDENCE CONSTANT IS NOT THE METER'S LABEL: 0.02 (evidence) vs 0.03 (the meter's
// provisional speechLike log label) are DIFFERENT decisions, independently tunable —
// E4 pins the separation with a window that is evidence but not speechLike.
import { describe, it, expect } from "vitest";
import {
  CallerEnergyEvidence,
  DEFAULT_ENERGY_EVIDENCE_RMS,
  DEFAULT_ENERGY_EVIDENCE_WINDOWS,
} from "../src/voice-caller-energy.js";
import { AudioEnergyMeter, type EnergyWindow } from "../src/voice-audio-energy.js";
import {
  runIntakeCall,
  type IntakeDeps,
  type TimedTranscript,
} from "../src/voice-agent-session.js";
import type { CallJobMetadata } from "../src/call-bridge.js";

/** A synthetic closed window. `duringPlayout` mirrors the meter's majority rule
 *  (playoutFraction >= 0.5 — voice-audio-energy.ts closeWindow); E6 pins that rule
 *  against the REAL meter so a later meter change cannot silently move this gate. */
function win(rms: number, playoutFraction: number, index = 0): EnergyWindow {
  return {
    index,
    startMs: index * 300,
    endMs: (index + 1) * 300,
    rms,
    peak: Math.min(1, rms * 4),
    speechLike: rms >= 0.03,
    speechRun: 0,
    playoutFraction,
    duringPlayout: playoutFraction >= 0.5,
  };
}

describe("CallerEnergyEvidence — the tracker (rms >= 0.02, clear, 2 consecutive)", () => {
  it("E1: fix-25 replay — 0.0511(clear) / 0.0905(playout 0.73) / 0.0516(clear) fires evidence exactly at the third window", () => {
    // The measured numbers from the call that hung up on the owner, in sequence. The
    // during-playout window HOLDS the run (does not reset it), so the two clear
    // windows around it are consecutive qualifying windows. VACUOUS IF evidence fired
    // on the FIRST window (a 1-window rule would also "fire eventually") — the
    // false/false/true sequence pins both the threshold and the consecutive count.
    const t = new CallerEnergyEvidence();
    expect(t.onWindow(win(0.0511, 0))).toBe(false); // run 1 — not yet evidence
    expect(t.onWindow(win(0.0905, 0.73))).toBe(false); // during playout: HOLD, ambiguous
    expect(t.onWindow(win(0.0516, 0))).toBe(true); // run 2 — evidence
    expect(t.evidenceWindows()).toBe(1);
  });

  it("E2: echo protection — loud windows ONLY during playout NEVER fire, however many", () => {
    // The echo signature is inbound energy while OUR audio plays (the meter's header).
    // VACUOUS IF the rms were below the threshold (they would fail for the wrong
    // reason) — 0.19 is far above any threshold in play.
    const t = new CallerEnergyEvidence();
    for (let i = 0; i < 50; i += 1) {
      expect(t.onWindow(win(0.19, 0.9, i))).toBe(false);
    }
    expect(t.evidenceWindows()).toBe(0);
  });

  it("E3: a single isolated clear speech window does not fire, and a quiet window RESETS the run", () => {
    // clear / quiet / clear: two qualifying windows that are NOT consecutive. VACUOUS
    // IF quiet merely held the run (the two clears would then fire) — the final false
    // pins the reset, and the leading pair pins that one window alone is never enough.
    const t = new CallerEnergyEvidence();
    expect(t.onWindow(win(0.0511, 0))).toBe(false);
    expect(t.onWindow(win(0.0011, 0))).toBe(false); // the measured quiet floor
    expect(t.onWindow(win(0.0511, 0))).toBe(false); // run restarted at 1, not 2
    expect(t.evidenceWindows()).toBe(0);
  });

  it("E4: the 0.02 evidence constant is SEPARATE from the meter's 0.03 label — two 0.025 windows fire", () => {
    // 0.025 is below the meter's provisional speechLike threshold (these windows log
    // speech:false) but above the evidence threshold. VACUOUS IF the tracker read the
    // window's speechLike field instead of rms — 0.025 discriminates the two.
    const t = new CallerEnergyEvidence();
    expect(DEFAULT_ENERGY_EVIDENCE_RMS).toBe(0.02);
    expect(DEFAULT_ENERGY_EVIDENCE_WINDOWS).toBe(2);
    const a = win(0.025, 0);
    expect(a.speechLike).toBe(false); // the meter would NOT label this speech
    expect(t.onWindow(a)).toBe(false);
    expect(t.onWindow(win(0.025, 0))).toBe(true); // but it IS caller evidence
  });

  it("E5: both numbers are injectable, and a mis-wired tracker dies at composition", () => {
    // Carrier variance is the stated risk (moderate confidence off this trunk): the
    // worker must be able to move both numbers from its env edge. VACUOUS IF the
    // options were accepted but unread — the 0.05 windows below discriminate.
    const strict = new CallerEnergyEvidence({ rmsThreshold: 0.06, consecutiveWindows: 3 });
    expect(strict.onWindow(win(0.05, 0))).toBe(false); // below the raised threshold
    expect(strict.onWindow(win(0.07, 0))).toBe(false); // run 1 of 3
    expect(strict.onWindow(win(0.07, 0))).toBe(false); // run 2 of 3
    expect(strict.onWindow(win(0.07, 0))).toBe(true); // run 3 of 3
    // Loud-or-not-at-all at composition (the meter's own rule, same file family).
    expect(() => new CallerEnergyEvidence({ rmsThreshold: 0 })).toThrow(/rmsThreshold/);
    expect(() => new CallerEnergyEvidence({ rmsThreshold: 1.5 })).toThrow(/rmsThreshold/);
    expect(() => new CallerEnergyEvidence({ consecutiveWindows: 0 })).toThrow(/consecutiveWindows/);
    expect(() => new CallerEnergyEvidence({ consecutiveWindows: 2.5 })).toThrow(/consecutiveWindows/);
  });

  it("E6: the duringPlayout gate is pinned to the METER's majority rule — part-playout windows (fraction < 0.5) count as CLEAR", () => {
    // Fed through a REAL AudioEnergyMeter so a later change to the meter's 0.5
    // majority cutoff breaks THIS test instead of silently moving the evidence gate.
    // 27% playout -> duringPlayout false -> qualifying; 73% playout -> duringPlayout
    // true -> hold. VACUOUS IF the tracker recomputed its own fraction rule from
    // playoutFraction — it must consume the meter's classification.
    const meter = new AudioEnergyMeter({ sampleRate: 1_000, windowMs: 100 }); // 100-sample windows
    const t = new CallerEnergyEvidence();
    const loud = (n: number) => new Int16Array(n).fill(6_554); // ~0.2 full-scale
    const windows: EnergyWindow[] = [];
    // Two windows at 27% playout: 27 playout samples then 73 clear, twice.
    for (let k = 0; k < 2; k += 1) {
      windows.push(...meter.onFrame(loud(27), true));
      windows.push(...meter.onFrame(loud(73), false));
    }
    expect(windows).toHaveLength(2);
    expect(windows[0]!.playoutFraction).toBeCloseTo(0.27, 5);
    expect(windows[0]!.duringPlayout).toBe(false); // the meter's rule: 0.27 < 0.5 -> CLEAR
    expect(t.onWindow(windows[0]!)).toBe(false);
    expect(t.onWindow(windows[1]!)).toBe(true); // two consecutive CLEAR windows -> evidence
    // Now 73% playout: majority-playout windows HOLD, never fire.
    const held: EnergyWindow[] = [];
    for (let k = 0; k < 3; k += 1) {
      held.push(...meter.onFrame(loud(73), true));
      held.push(...meter.onFrame(loud(27), false));
    }
    expect(held).toHaveLength(3);
    expect(held[0]!.duringPlayout).toBe(true); // 0.73 >= 0.5 -> during playout
    const before = t.evidenceWindows();
    for (const w of held) t.onWindow(w);
    expect(t.evidenceWindows()).toBe(before); // held throughout — no new evidence
  });
});

// ─── the loop-level replay: energy defeats countedSilence, per answer window ─────────

function makeClock(start: number) {
  let t = start;
  return { now: () => t, set: (v: number) => void (t = v) };
}

const THREE_PROMPTS: CallJobMetadata = {
  v: 1,
  touchId: "00000000-0000-0000-0000-0000000000d4",
  contactId: "00000000-0000-0000-0000-0000000000a1",
  displayName: "Ana Reyes",
  openingLine: "Hi, may I speak with Ana Reyes?",
  prompts: [
    { id: "q1", questionKey: "budget", promptText: "What budget range are you working with?" },
    { id: "q2", questionKey: "timeline", promptText: "When are you hoping to move?" },
    { id: "q3", questionKey: "areas", promptText: "Which areas are you considering?" },
  ],
};

/** The answer-window fake (seamFakeDeps' shape) wired to a REAL tracker: the session's
 *  optional energy eye reads tracker.evidenceWindows(), and each scripted wait may feed
 *  measured windows before timing out — exactly what the worker's pump does live. */
function energyFakeDeps(opts: {
  clock: { now: () => number; set: (v: number) => void };
  tracker: CallerEnergyEvidence;
  answers: Array<(timeoutMs: number) => TimedTranscript | null>;
}) {
  const ops: string[] = [];
  const instrumented: Array<{ event: string; detail: Record<string, unknown> }> = [];
  let i = 0;
  const deps: IntakeDeps = {
    session: {
      say: async (text) => {
        ops.push(`say:${text}`);
        opts.clock.set(opts.clock.now() + 500);
        return { delivered: true, voicedAt: opts.clock.now() };
      },
      nextFinalTranscript: async (timeoutMs) => {
        const step = opts.answers[i++];
        if (step === undefined) {
          opts.clock.set(opts.clock.now() + timeoutMs);
          return null;
        }
        return step(timeoutMs);
      },
      callerEnergyEvidenceWindows: () => opts.tracker.evidenceWindows(),
    },
    persistAnswer: async (questionId, value) => {
      ops.push(`persist:${questionId}:${value}`);
    },
    reached: async () => {},
    publishReport: async (report) => {
      ops.push(`report:${String(report.conversation)}:${report.answersPersisted}`);
    },
    hangUp: async () => {
      ops.push("hangUp");
    },
    now: opts.clock.now,
    instrument: (event, detail) => {
      instrumented.push({ event, detail });
    },
  };
  return { deps, ops, instrumented };
}

describe("the answer window and caller energy — fix-25 must not repeat", () => {
  it("E7: fix-25 replay — a window where the meter heard sustained clear speech does NOT count silence, and two such windows do NOT end the call", async () => {
    // The call that hung up on the owner, replayed at the loop: two answer windows
    // expire with zero transcripts while the tracker fires on the measured trio
    // (0.0511 clear / 0.0905 playout 0.73 / 0.0516 clear). Pre-fix, those two
    // countedSilence windows ended the call before q3 — the assertion on say:q3 is
    // the hangup itself. The THIRD window gets NO energy and must still count: the
    // per-window snapshot may not let earlier evidence leak forward. VACUOUS IF the
    // job had only two prompts (the dead-line break cannot fire before the last
    // question, so the call would "survive" without the fix), or if energy were fed
    // outside the windows only (the snapshot comparison would never move).
    const clock = makeClock(0);
    const tracker = new CallerEnergyEvidence();
    const feedMeasuredTrio = () => {
      tracker.onWindow(win(0.0511, 0));
      tracker.onWindow(win(0.0905, 0.73));
      tracker.onWindow(win(0.0516, 0));
    };
    const h = energyFakeDeps({
      clock,
      tracker,
      answers: [
        (t) => {
          feedMeasuredTrio(); // the caller talks mid-window (w188-shaped)…
          clock.set(clock.now() + t); // …but no transcript ever comes (the live defect)
          return null;
        },
        (t) => {
          feedMeasuredTrio(); // w237/w238-shaped, same zero-transcript window
          clock.set(clock.now() + t);
          return null;
        },
        (t) => {
          clock.set(clock.now() + t); // a genuinely silent window — no energy at all
          return null;
        },
      ],
    });
    const report = await runIntakeCall(THREE_PROMPTS, "human", h.deps);
    // The call SURVIVED to the last question — pre-fix it hung up after two windows.
    expect(h.ops).toContain("say:Which areas are you considering?");
    // Both energy-backed expiries declined to count silence, and said why.
    const expiries = h.instrumented.filter((e) => e.event === "answer-window-expiry");
    expect(expiries).toHaveLength(3);
    expect(expiries[0]!.detail["countedSilence"]).toBe(false);
    expect(expiries[0]!.detail["energyEvidence"]).toBe(true);
    expect(expiries[1]!.detail["countedSilence"]).toBe(false);
    expect(expiries[1]!.detail["energyEvidence"]).toBe(true);
    // The silent third window still counts — evidence is per-window, never carried.
    expect(expiries[2]!.detail["countedSilence"]).toBe(true);
    expect(expiries[2]!.detail["energyEvidence"]).toBe(false);
    // The report stays HONEST: energy rescued the line, it never fabricated answers.
    expect(report.conversation).toBe("identity_not_asked_cut_off");
    expect(report.answersPersisted).toBe(0);
  });

  it("E8: energy that fails the rule — echo-only and isolated windows — rescues NOTHING: the dead-line break still fires", async () => {
    // The honest-death property, narrowed as reviewed (F4): a broken call with no
    // caller evidence of ANY kind still counts its silences and dies. The windows fed
    // here are exactly the non-evidence shapes: the measured quiet floor, loud
    // echo-shaped during-playout windows, and ONE isolated clear window (quiet-reset
    // on both sides). VACUOUS IF any fed sequence contained two consecutive clear
    // qualifying windows — that is E7. Pre-fix and post-fix behaviour must be
    // IDENTICAL here: two counted silences, q3 never asked.
    const clock = makeClock(0);
    const tracker = new CallerEnergyEvidence();
    const feedNonEvidence = () => {
      tracker.onWindow(win(0.0011, 0)); // the measured quiet floor
      tracker.onWindow(win(0.19, 0.9)); // loud, but DURING playout — the echo shape
      tracker.onWindow(win(0.19, 0.9));
      tracker.onWindow(win(0.0511, 0)); // one isolated clear window…
      tracker.onWindow(win(0.0011, 0)); // …reset before a second could join it
    };
    const h = energyFakeDeps({
      clock,
      tracker,
      answers: [
        (t) => {
          feedNonEvidence();
          clock.set(clock.now() + t);
          return null;
        },
        (t) => {
          feedNonEvidence();
          clock.set(clock.now() + t);
          return null;
        },
      ],
    });
    const report = await runIntakeCall(THREE_PROMPTS, "human", h.deps);
    expect(h.ops).not.toContain("say:Which areas are you considering?"); // the break fired
    const expiries = h.instrumented.filter((e) => e.event === "answer-window-expiry");
    expect(expiries).toHaveLength(2);
    expect(expiries[0]!.detail["countedSilence"]).toBe(true);
    expect(expiries[0]!.detail["energyEvidence"]).toBe(false);
    expect(expiries[1]!.detail["countedSilence"]).toBe(true);
    expect(expiries[1]!.detail["energyEvidence"]).toBe(false);
    expect(report.conversation).toBe("identity_not_asked_cut_off");
    expect(report.answersPersisted).toBe(0);
  });
});
