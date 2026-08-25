// Text pins for `voice-agent/worker-direct.ts` (WD1–WD8) — the direct-socket
// composition root. That file sits OUTSIDE every tsconfig (the same standing as
// worker.ts and scripts/executor-loop.ts, whose header records the snake_case bug that
// shipped precisely because no compiler ever saw it), so no type-level pin can reach
// it; it is typechecked by hand in the verification gates and pinned HERE as text —
// the repo's established pattern for source the build cannot see (cf.
// ingest/test/disabled-source-door.test.ts reading src/queue.ts).
//
// WHAT WOULD MAKE THESE PINS VACUOUS, and how each guard is anchored:
//   · A symbol mentioned only in a COMMENT would satisfy a naive `contains` — the
//     worker's comments cite these modules by name constantly. So every POSITIVE pin
//     runs against `codeLines()` (comment-stripped) and requires the symbol on at
//     least TWO distinct code lines: the import line AND a use site. Residual gap,
//     accepted and named: a trailing inline comment on a code line (`foo(); // bar`)
//     still counts, and a continuation line beginning with `*` (multiplication) would
//     be wrongly dropped — neither shape exists in the worker today, and either
//     appearing around one of THESE symbols should trip a reviewer anyway.
//   · The NEGATIVE pins run against the FULL text, which is strictly stronger than
//     code-only: the banned strings may not appear even in a comment (the worker's
//     comments refer to them obliquely on purpose), so a comment cannot shelter a
//     later paste of the killer field.
//   · An empty or moved file would pass every negative pin — WD1 anchors existence
//     and substance first, so the negatives cannot go vacuous by deletion.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const src = readFileSync(
  new URL("../../voice-agent/worker-direct.ts", import.meta.url),
  "utf8",
);

/** Comment-stripped view: drops /* … *​/ blocks, full-line `//` comments, and JSDoc
 *  continuation lines (leading `*`). See the header for the named residual gaps. */
function codeLines(text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes("*/")) inBlock = false;
      continue;
    }
    if (t.startsWith("/*")) {
      if (!t.includes("*/")) inBlock = true;
      continue;
    }
    if (t.startsWith("//") || t.startsWith("*")) continue;
    out.push(line);
  }
  return out;
}

const code = codeLines(src);
const codeLinesWith = (needle: string | RegExp): string[] =>
  code.filter((l) => (typeof needle === "string" ? l.includes(needle) : needle.test(l)));

describe("worker-direct.ts text pins — the untypecheckable composition root", () => {
  it("WD1: the file exists and is a worker, not a stub (anti-vacuity anchor for the negatives)", () => {
    expect(code.length).toBeGreaterThan(100);
    expect(codeLinesWith("defineAgent").length).toBeGreaterThan(0);
    expect(codeLinesWith("cli.runApp").length).toBeGreaterThan(0);
  });

  it("WD2: registers under the DIRECT agent-name env var with the -direct fallback — never the plugin worker's name (the dispatch-POOL hazard: call-transport.ts:299-301 dispatches by name, and a stale worker.ts under the same name silently claims production calls)", () => {
    expect(codeLinesWith("LIVEKIT_AGENT_NAME_DIRECT").length).toBeGreaterThan(0);
    // the derived fallback `${LIVEKIT_AGENT_NAME}-direct`
    expect(codeLinesWith("-direct").length).toBeGreaterThan(0);
    // and the same-name startup refusal (registering as the plugin worker forms the pool)
    expect(codeLinesWith(/directAgentName === process\.env\.LIVEKIT_AGENT_NAME/).length).toBe(1);
  });

  it("WD3: the live-bought audio helpers are imported AND called — owned PCM decode (spike call #2's interference) and the serialised capture queue (spike call #1's InvalidState kill). Call-site regexes, not bare contains: the worker's error-message STRINGS also name these symbols, and a string would satisfy a contains-count with the real call deleted", () => {
    expect(codeLinesWith(/import \{ SerialQueue, ownedPcm16FromBase64 \}/).length).toBe(1);
    expect(codeLinesWith(/ownedPcm16FromBase64\(/).length).toBeGreaterThan(0);
    expect(codeLinesWith(/new SerialQueue\(/).length).toBeGreaterThan(0);
  });

  it("WD3b: usage is captured WITH its modality split and priced at the end of the call — a bare totalTokenCount is unpriceable (Live bills audio ~6x text), which is why the first three weeks of call logs could not answer 'what did that call cost'. Call-site regexes so deleting the arithmetic cannot pass on the import alone", () => {
    // The split reaches the event: without these two, cost is a guess forever.
    expect(codeLinesWith(/promptByModality: modalitySplit\(/).length).toBe(1);
    expect(codeLinesWith(/responseByModality: modalitySplit\(/).length).toBe(1);
    // Thinking bills at the OUTPUT rate — omitting it under-reports every call.
    expect(codeLinesWith(/thoughtsTokens: /).length).toBeGreaterThan(0);
    // And the call actually prices itself, from the wire's numbers.
    expect(codeLinesWith(/accumulateUsage\(usageSamples\)/).length).toBe(1);
    expect(codeLinesWith(/priceCall\(/).length).toBe(1);
    expect(codeLinesWith(/"call-cost"/).length).toBe(1);
  });

  it("WD3c: BOTH readings of the usage series are reported — the Live docs never say whether a usageMetadata report restates a running session total or prices one turn, and the two differ ~10x on the same call. Reporting one number would silently pick an answer we do not have", () => {
    expect(codeLinesWith(/usdIfPerTurn:/).length).toBe(1);
    expect(codeLinesWith(/usdIfCumulative:/).length).toBe(1);
    expect(codeLinesWith(/monotonic:/).length).toBe(1);
  });

  it("WD4: PreVerdictGate is constructed AND seen deciding on the hot path — pre-verdict the model receives nothing (strictly stronger than the plugin's pauseReplyAuthorization, voice-direct-gates.ts)", () => {
    expect(codeLinesWith(/new PreVerdictGate\(\)/).length).toBe(1);
    expect(codeLinesWith(/gate\.offerCallerFrame\(/).length).toBeGreaterThan(0);
    expect(codeLinesWith(/gate\.maySendDirective\(\)/).length).toBeGreaterThan(0);
    expect(codeLinesWith(/gate\.settle\(/).length).toBeGreaterThan(0);
  });

  it("WD5: AMD runs with calleeAmdOptions() VERBATIM (all four pinned decisions, voice-agent-session.ts) and the real intake loop runIntakeCall drives the call — call-site anchors for the same string-literal reason as WD3", () => {
    expect(codeLinesWith(/= calleeAmdOptions\(\)/).length).toBe(1);
    expect(codeLinesWith(/await runIntakeCall\(job, verdict\.category/).length).toBe(1);
  });

  it("WD6: NO speech-config language field, anywhere in the file — the fifth member of the 1007 socket-kill family (its type, DirectSpeechConfig, cannot carry it; this pins the worker from writing it outside the builder)", () => {
    // full text, comments included — see the header for why full-text is the point
    expect(src.includes("language" + "Code")).toBe(false);
  });

  it('WD7: NO model-role client turn, anywhere in the file — the prompt-leak mechanism (the plugin\'s injections taught the model to read wrapper text aloud; on 3.1 models a model-role turn is a session-killing 1007)', () => {
    expect(/role\s*:\s*["'`]model["'`]/.test(src)).toBe(false);
  });

  it("WD8: realtime audio goes up under the `audio:` field (never its deprecated sibling — a known 1007 cause) and exactly ONE audio track is published (#1248)", () => {
    expect(codeLinesWith("sendRealtimeInput").length).toBeGreaterThan(0);
    expect(codeLinesWith(/audio:\s*\{\s*data/).length).toBeGreaterThan(0);
    expect(codeLinesWith(/\bmedia\s*:/).length).toBe(0);
    expect(codeLinesWith("createAudioTrack(").length).toBe(1);
    expect(codeLinesWith(".publishTrack(").length).toBe(1);
  });

  it("WD9: 3.1 telephony VAD tuning is passed to the builder AND model-gated — the measured fix for the 9.8s commit hang (probe-asr run-teltuned31.log: 9.8s -> 1.8s), gated so 2.5 (commits in 2-4s today, the known-good fallback) keeps its default turn detection. Call-site regexes per WD3: comments cite these names too", () => {
    // The gate expression at the call site: a SPREAD-gated input keyed on the model id
    // (the same `.includes("3.1")` the call-cost rate-card selection uses), never an
    // unconditional field — deleting the ternary or inlining the block ungated reds here.
    expect(codeLinesWith(/\.\.\.\(VOICE_MODEL\.includes\("3\.1"\)\s*\?\s*\{ automaticActivityDetection:/).length).toBe(1);
    // The measured values, verbatim, on code lines (the typed const the gate passes).
    expect(codeLinesWith(/endOfSpeechSensitivity: "END_SENSITIVITY_HIGH"/).length).toBe(1);
    expect(codeLinesWith(/silenceDurationMs: 500/).length).toBe(1);
    // CODE-line negative (not full-text: the hazard comment must be free to name it):
    // `disabled` under automaticActivityDetection is an INSTANT 1007 socket kill
    // (probe31 log-e-activity.log) — no code line may carry the word at all.
    expect(codeLinesWith(/disabled/).length).toBe(0);
  });

  it("WD10: every inbound caller frame is fed to the energy meter WITH the playout flag, and the call logs an energy summary — the instrument that makes 'was the caller speaking' and the echo hypothesis decidable from a log. Call-site regexes per WD3; the meter observes only (a barge-in gate is a separate, unapproved decision)", () => {
    // The import AND the construction — a meter imported but never built measures
    // nothing.
    expect(codeLinesWith(/import \{ AudioEnergyMeter \}/).length).toBe(1);
    expect(codeLinesWith(/new AudioEnergyMeter\(/).length).toBe(1);
    // The feed call-site, verbatim: the frame's samples AND the playout flag from the
    // one published AudioSource's queue (queuedDuration > 0 = unplayed audio remains =
    // our voice is on the line). Without the flag the echo correlation — the whole
    // reason the meter exists — is unmeasurable, so the flag is pinned INSIDE the
    // call-site regex, not as a separate contains.
    expect(
      codeLinesWith(/energy\.onFrame\(value\.data, source\.queuedDuration > 0\)/).length,
    ).toBe(1);
    // The periodic line and the end-of-call summary both reach the log.
    expect(codeLinesWith(/log\("energy",/).length).toBe(1);
    expect(codeLinesWith(/"energy-summary"/).length).toBe(1);
    // And the meter did not displace the existing accounting: framesIn still counts
    // every frame (the number that let us say '~8,700 frames in 88s' at all).
    expect(codeLinesWith(/framesIn \+= 1/).length).toBe(1);
  });

  it("WD11: the model-turn tracker is constructed, fed every wire event it accounts, and injected BOTH as the speech channel's turn gate and as the loop's modelTurnDeadline seam — with the per-turn / per-interrupt instrumentation lines the live gate needs (levels, counts and timestamps ONLY). Call-site regexes per WD3: the comments cite every one of these names", () => {
    // Import AND construction — a tracker imported but never built accounts nothing.
    expect(codeLinesWith(/import \{ ModelTurnTracker \}/).length).toBe(1);
    expect(codeLinesWith(/new ModelTurnTracker\(/).length).toBe(1);
    // Every feed the tracker's arithmetic depends on, at its call-site:
    expect(codeLinesWith(/modelTurns\.onDirectiveSent\(\)/).length).toBe(1);
    expect(codeLinesWith(/modelTurns\.onAudioFrame\(/).length).toBe(1);
    expect(codeLinesWith(/modelTurns\.onCallerFragment\(\)/).length).toBe(1);
    expect(codeLinesWith(/modelTurns\.onGenerationComplete\(\)/).length).toBe(1);
    expect(codeLinesWith(/modelTurns\.onTurnComplete\(\)/).length).toBe(1);
    expect(codeLinesWith(/modelTurns\.onInterrupted\(\)/).length).toBe(1);
    // The deadline is consulted from exactly TWO seats: the speech channel's turnGate
    // (a say parks behind an in-flight turn) and the intake loop's modelTurnDeadline
    // seam (expiry waits, bounded) — one wiring missing and half the fix is inert.
    expect(codeLinesWith(/modelTurns\.sendWaitDeadline\(\)/).length).toBe(2);
    expect(codeLinesWith(/turnGate: \{ sendWaitDeadline:/).length).toBe(1);
    expect(codeLinesWith(/modelTurnDeadline: \(\) =>/).length).toBe(1);
    // The caller-turn half of the unified invariant, off the assembler's own stamps.
    expect(codeLinesWith(/callerTurnStartedAt: \(\) => assembler\.openTurnStartedAt\(\)/).length).toBe(1);
    // The instrumentation lines themselves: the directive's wall stamp (its delta to
    // any interrupted is that event's msSinceDirective), the per-turn open line, and
    // queuedDuration read BEFORE clearQueue (read after, the number is always 0).
    expect(codeLinesWith(/log\("send-directive"\)/).length).toBe(1);
    expect(codeLinesWith(/log\("model-turn-open"\)/).length).toBe(1);
    expect(codeLinesWith(/queuedDurationAtClear = source\.queuedDuration/).length).toBe(1);
    expect(codeLinesWith(/queuedDurationAtClear,/).length).toBe(1);
    // The estimate-validation number reaches the turn-complete line: this is what
    // turns 'turnComplete ≈ firstAudio + audioMs' from an n=2 dry-socket reading into
    // a measured property of the live telephony leg.
    expect(codeLinesWith(/generationToTurnCompleteLagMs: modelTurn\.generationToTurnCompleteLagMs/).length).toBe(1);
    // The loop's window stamps flow to the log, and expiry carries the assembler's
    // own isTurnOpen() beside the seam's view of the same fact.
    expect(codeLinesWith(/instrument: \(event, detail\)/).length).toBe(1);
    expect(codeLinesWith(/isTurnOpen: assembler\.isTurnOpen\(\)/).length).toBe(1);
  });

  it("WD11b: interrupt classification is LOGGING-ONLY this phase — the reading reaches exactly one seat (the interrupted log line) and no code line branches on it. The review proved that changing how an interrupted settles the pending say, without turn attribution, re-creates the 2026-08-22 leak-call corruption or throws the honest death; the negative here runs against code lines so a comment cannot trip it and a branch cannot hide in one", () => {
    // The reading is taken once…
    expect(codeLinesWith(/modelTurns\.onInterrupted\(\)/).length).toBe(1);
    // …consumed only inside the log object (classification appears on exactly one
    // code line, the log field)…
    expect(codeLinesWith(/reading\.classification/).length).toBe(1);
    expect(codeLinesWith(/classification: reading\.classification/).length).toBe(1);
    // …and NOTHING branches on it: no if/switch/ternary-condition over the reading or
    // its fields anywhere in the file's code.
    expect(codeLinesWith(/if \(.*reading\./).length).toBe(0);
    expect(codeLinesWith(/switch \(.*reading/).length).toBe(0);
    expect(codeLinesWith(/reading\.classification ===/).length).toBe(0);
    expect(codeLinesWith(/"self_inflicted"/).length).toBe(0);
  });
});

describe("WD12: invention detection is wired — and it is DETECTION AND LOGGING ONLY", () => {
  // 2026-08-24 live call: invented questions rode AUTO-REPLIES. The InventionMonitor
  // (crm/src/voice-invention.ts) classifies each closed model turn post hoc; the
  // adversarial review's constraint stands — NOTHING may branch on the verdict to
  // change call behaviour (altering interrupt/turn handling without a full
  // turn-attribution state machine re-creates the 2026-08-22 leak-call corruption).
  it("WD12a: the monitor is constructed and fed at all three seams — directive, output transcription, turn close (complete AND interrupted)", () => {
    // VACUOUS IF matched against comments — codeLines() strips them (file header).
    expect(codeLinesWith(/new InventionMonitor\(\)/).length).toBe(1);
    expect(codeLinesWith(/invention\.onDirective\(/).length).toBe(1);
    expect(codeLinesWith(/invention\.onOutputFragment\(/).length).toBe(1);
    expect(codeLinesWith(/invention\.onTurnClosed\(/).length).toBe(2); // turnComplete + interrupted
    expect(codeLinesWith(/suspectedInventions: invention\.suspectedCount\(\)/).length).toBe(1); // the call-done summary
  });

  it("WD12b: the verdict reaches log lines and nothing else — no flush, no settle, no send, no teardown", () => {
    // Every code line touching the monitor or its verdict must be free of the
    // behavioural surfaces; the verdict may gate only its own log line.
    const touching = codeLinesWith(/invention\.|inventionVerdict/);
    expect(touching.length).toBeGreaterThan(0); // anti-vacuity: the wiring exists
    for (const l of touching) {
      expect(l).not.toMatch(
        /speech\.|source\.|gemini|clearQueue|sendClientContent|deleteRoom|hangUp|assembler\.|modelTurns\.on/,
      );
    }
  });

});

describe("WD13: thinking OFF for 2.5 native audio — model-gated, env-overridable at the edge", () => {
  it("WD13: the builder receives thinkingConfig through the 2.5 model gate, the budget is parsed from VOICE_THINKING_BUDGET at the worker's edge, and no unshipped thinking field is on a code line", () => {
    // The gate expression at the call site, same shape as WD9's VAD gate: a
    // SPREAD-gated input keyed on the model id (the same `.includes(...)` the VAD
    // tuning and the call-cost rate-card selection use) — deleting the ternary or
    // inlining the block ungated reds this line. VACUOUS IF matched against full text
    // (the comments name every one of these symbols) — codeLines() only, per the
    // file header, and the payload rides INSIDE the gate regex so a gate kept while
    // the payload moves out of it cannot pass.
    expect(
      codeLinesWith(
        /\.\.\.\(VOICE_MODEL\.includes\("2\.5"\)\s*\?\s*\{ thinkingConfig: \{ thinkingBudget: THINKING_BUDGET_2_5 \} \}/,
      ).length,
    ).toBe(1);
    // The env override is parsed at the worker's edge (the crm module never reads
    // process.env — same doctrine as VOICE_STALE_TC_WINDOW_MS and the energy
    // thresholds): the live revert path. VOICE_THINKING_BUDGET=-1 restores the model
    // default (dynamic thinking) without a rebuild; there is NO useful middle value
    // (see the const's comment), so the override IS the whole revert story.
    expect(codeLinesWith(/Number\(process\.env\.VOICE_THINKING_BUDGET\)/).length).toBe(1);
    expect(codeLinesWith(/process\.env\.VOICE_THINKING_BUDGET/).length).toBeGreaterThan(1);
    // CODE-line negatives (the comments must stay free to name them): thinkingLevel
    // and includeThoughts are measured-useless here and are NOT shipped.
    expect(codeLinesWith(/thinkingLevel/).length).toBe(0);
    expect(codeLinesWith(/includeThoughts/).length).toBe(0);
  });
});
