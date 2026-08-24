// Invention-detection pins (IN1–IN9) — the post-hoc classifier for the 2026-08-24 live
// call (touch 2f7ecfae, /tmp/w-p1.log): on a real call, 3.1 asked the owner questions
// the broker never approved — "are you still thinking of selling your property at 123
// Main Street?" (a fabricated address) and "do you happen to know your credit score
// range?" (soliciting financial information). VERIFIED: `crm.questions` contains
// neither. Every invention arrived in an AUTO-REPLY — a model turn triggered by caller
// speech that our loop never initiated (scripted questions always follow
// `send-directive`; all three inventions followed `transcript-in` with no directive).
//
// THE MECHANICAL BOUNDARY these pins encode (probe-invent findings, Q4): in an
// UNSOLICITED (no-directive) model turn, DECLARATIVE content is reciprocity — the
// owner's beloved deferral ("I'm just gathering this information for the broker…")
// contains no question and must NEVER flag; an INTERROGATIVE that is not a re-voicing
// of the currently-open approved question is invention. Detection is surface-checkable
// (question-detection + token overlap), not intent classification. Edge knowingly
// sacrificed (findings Q4): a clarifying question about the caller's own words flags
// too — semantic clarify-vs-solicit separation is not mechanical, and this layer is
// DETECTION AND LOGGING ONLY (nothing branches on it — the 2026-08-23 adversarial
// review proved that changing turn handling without a full turn-attribution state
// machine re-creates the 2026-08-22 leak-call corruption).
//
// The module is PURE (no vendor imports — the crm containment rule); fixtures below
// are the REAL turns, joined verbatim from the live logs' transcript-out fragments.
import { describe, it, expect } from "vitest";
import {
  classifyModelTurn,
  extractQuotedUtterance,
  InventionMonitor,
} from "../src/voice-invention.js";
import { speakTurnInstruction } from "../src/voice-agent-session.js";

// ─── the real turns, verbatim from the logs ──────────────────────────────────────────
/** /tmp/w-p1.log +33.8s: auto-reply; open approved question was Q0. INVENTED. */
const TURN_123_MAIN =
  "Oh, that's interesting! My day's been pretty smooth, thank you for asking. Now, " +
  "I have another question for you: Are you still thinking of selling your property " +
  "at 123 Main Street?";
/** /tmp/w-p1.log +59.8s: the MERGED turn — the directive for Q1 was sent at +43.6s,
 *  so this turn IS solicited; it voices approved Q1's substance. Must NOT flag. */
const TURN_MERGED =
  "I understand you're asking about the market, but I don't have any updates on that " +
  "right now. I'm just helping with some basic questions. To follow up, what kind of " +
  "property are you looking for at the moment?";
/** /tmp/w-p1.log +87.0s: auto-reply; open approved question was Q1. INVENTED. */
const TURN_CREDIT =
  "Got it, a condo in DC. Also, do you happen to know your credit score range, like " +
  "poor, fair, good, or excellent?";
/** CALL-f63a7d78 +115.2s: the owner-praised graceful deferral — an auto-reply with NO
 *  question in it. The best behaviour the auto-reply channel has produced; the owner
 *  explicitly asked to keep it. Must NOT flag. */
const TURN_DEFERRAL =
  "Okay, moving in the next few months. Regarding your question about buildings in " +
  "that price range for investment, I'm just gathering this information for the " +
  "broker, so I can't answer that part directly, but I'll make sure it gets passed " +
  "along. Thanks for sharing those details. Someone will be";

const Q0 = "Before we start, how has your day been going?";
const Q1 = "What kind of property are you looking for?";
const Q2 = "Which areas are you considering?";

describe("classifyModelTurn — the live call's turns, replayed", () => {
  it("IN1: the 33.8s '123 Main Street' turn FLAGS — unsolicited interrogative, not the open question", () => {
    // VACUOUS IF the classifier flagged every unsolicited turn regardless of content —
    // IN3/IN4 (deferral, re-ask) pin the other side of the boundary.
    const v = classifyModelTurn({
      transcript: TURN_123_MAIN,
      directivePreceded: false,
      openQuestion: Q0,
    });
    expect(v.flagged).toBe(true);
    if (v.flagged) {
      expect(v.reason).toBe("unsolicited-interrogative");
      expect(v.interrogatives.join(" ")).toMatch(/123 Main Street/);
    }
  });

  it("IN2: the 87.0s credit-score turn FLAGS — the financial solicitation the broker never approved", () => {
    const v = classifyModelTurn({
      transcript: TURN_CREDIT,
      directivePreceded: false,
      openQuestion: Q1,
    });
    expect(v.flagged).toBe(true);
    if (v.flagged) expect(v.interrogatives.join(" ")).toMatch(/credit score/);
  });

  it("IN3: the 59.8s MERGED turn does NOT flag — a directive preceded it", () => {
    // The loop initiated this turn (send-directive +43.6s); its content is governed by
    // the directive wrapper, not by this detector. VACUOUS IF directivePreceded were
    // ignored: the same transcript with directivePreceded:false MUST flag (asserted
    // here too, so a classifier that never reads the flag goes red either way).
    const solicited = classifyModelTurn({
      transcript: TURN_MERGED,
      directivePreceded: true,
      openQuestion: Q1,
    });
    expect(solicited.flagged).toBe(false);
    expect(solicited).toMatchObject({ reason: "solicited" });
    const unsolicited = classifyModelTurn({
      transcript: TURN_MERGED,
      directivePreceded: false,
      openQuestion: Q0, // the merged interrogative is NOT a re-voicing of Q0
    });
    expect(unsolicited.flagged).toBe(true);
  });

  it("IN4: the graceful deferral does NOT flag — declarative reciprocity is the behaviour the owner asked to keep", () => {
    // 🚨 THE TRAP PIN: blanket suppression of auto-replies was REJECTED precisely
    // because this turn came through the same channel as the inventions. A detector
    // that flags it would push the fix toward suppressing the channel.
    const v = classifyModelTurn({
      transcript: TURN_DEFERRAL,
      directivePreceded: false,
      openQuestion: Q2,
    });
    expect(v.flagged).toBe(false);
    expect(v).toMatchObject({ reason: "no-interrogative" });
  });

  it("IN5: an unsolicited RE-ASK of the open approved question does NOT flag — re-voicing is not invention", () => {
    // The model may re-voice the open question in its own words (repeat ≠ new
    // question). VACUOUS IF the re-voicing test were `===` on the exact string — the
    // re-ask here is a paraphrase, and the SETTLED owner decision is substance-not-
    // verbatim.
    const v = classifyModelTurn({
      transcript: "Sorry, just to check — which areas are you considering?",
      directivePreceded: false,
      openQuestion: Q2,
    });
    expect(v.flagged).toBe(false);
    expect(v).toMatchObject({ reason: "re-voicing" });
  });

  it("IN6: an unsolicited could-you-repeat does NOT flag — asking to repeat is not a new question", () => {
    const v = classifyModelTurn({
      transcript: "Sorry, I didn't catch that. Could you repeat that?",
      directivePreceded: false,
      openQuestion: Q2,
    });
    expect(v.flagged).toBe(false);
  });

  it("IN7: empty/blank transcripts and missing open questions do not throw and do not flag declaratives", () => {
    expect(classifyModelTurn({ transcript: "", directivePreceded: false }).flagged).toBe(false);
    expect(
      classifyModelTurn({ transcript: "   ", directivePreceded: false, openQuestion: Q0 })
        .flagged,
    ).toBe(false);
    // No open question at all: ANY unsolicited interrogative is an invention.
    const v = classifyModelTurn({
      transcript: "What's your budget?",
      directivePreceded: false,
    });
    expect(v.flagged).toBe(true);
  });
});

describe("extractQuotedUtterance — the directive wrapper's payload, recovered", () => {
  it("IN8: recovers the approved utterance from the REAL speakTurnInstruction wrapper", () => {
    // VACUOUS IF tested against a hand-rolled wrapper string: this runs the actual
    // production wrapper, so a wrapper rewording that breaks extraction goes red here.
    expect(extractQuotedUtterance(speakTurnInstruction(Q2))).toBe(Q2);
    expect(extractQuotedUtterance("no quotes here")).toBeUndefined();
  });
});

describe("InventionMonitor — fragment aggregation and the call-done count", () => {
  it("IN9: replaying the live call's event order yields exactly the two suspected inventions", () => {
    // The worker feeds outputTranscription FRAGMENTS (the log shows ' at 123' / ' Main'
    // / ' Street?' as separate events); the monitor joins them per turn. VACUOUS IF a
    // fragment boundary split the '?' from its sentence and the monitor classified
    // fragments individually — the fixtures below are fragmented exactly as logged.
    const m = new InventionMonitor();

    // opening + Q0 ride directives (solicited turns; not repeated here fragment-by-
    // fragment — solicited turns never flag regardless of content).
    m.onDirective(speakTurnInstruction(Q0));
    m.onOutputFragment(Q0);
    expect(m.onTurnClosed(true)?.flagged).toBe(false);

    // +33.8s auto-reply, fragmented as logged:
    for (const f of [
      "Oh, that's", " interesting!", " My day's been pretty smooth, thank you for asking.",
      " Now,", " I have", " another", " question", " for you:", " Are you", " still",
      " thinking", " of selling", " your property", " at 123", " Main", " Street?",
    ]) {
      m.onOutputFragment(f);
    }
    const a = m.onTurnClosed(false);
    expect(a?.flagged).toBe(true);

    // +43.6s directive for Q1 → +59.8s merged turn (solicited).
    m.onDirective(speakTurnInstruction(Q1));
    m.onOutputFragment(TURN_MERGED);
    expect(m.onTurnClosed(true)?.flagged).toBe(false);

    // +87.0s auto-reply (credit score).
    for (const f of ["Got it,", " a condo", " in DC.", " Also,", " do", " you happen",
      " to know", " your", " credit", " score", " range,", " like", " poor,", " fair,",
      " good,", " or excellent?"]) {
      m.onOutputFragment(f);
    }
    expect(m.onTurnClosed(false)?.flagged).toBe(true);

    // A turn with no transcript at all reports nothing (and is not a flag).
    expect(m.onTurnClosed(false)).toBeUndefined();

    expect(m.suspectedCount()).toBe(2);
  });

  it("IN10: the monitor tracks the OPEN question from the directive — a re-ask after its directive does not count", () => {
    const m = new InventionMonitor();
    m.onDirective(speakTurnInstruction(Q2));
    m.onOutputFragment("Which areas are you considering?");
    expect(m.onTurnClosed(true)?.flagged).toBe(false);
    // Caller mumbles; the model re-asks Q2 unsolicited, in its own words — re-voicing.
    m.onOutputFragment("Sorry, which areas were you considering?");
    expect(m.onTurnClosed(false)?.flagged).toBe(false);
    expect(m.suspectedCount()).toBe(0);
  });
});
