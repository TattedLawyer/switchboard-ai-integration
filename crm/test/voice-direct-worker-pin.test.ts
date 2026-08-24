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
});
