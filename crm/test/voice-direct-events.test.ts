// Direct-socket wire-grammar pins (E1–E5) — the typed grammar the Step-1 worker will
// speak over its own @google/genai Live socket, mirrored here as PLAIN DATA so crm/src
// never imports the vendor SDK (the containment rule: the worker passes real objects,
// tests pass fakes, the compiler checks the shape both ways — the same doctrine as
// `RealtimeReplyHandle` in voice-agent-session.ts).
//
// THE LEAK MECHANISM THESE PIN AGAINST: the plugin injects instructions as role:'model'
// (agents-plugin-google/src/realtime/realtime_api.ts:900-919); the model treats them as
// its own past speech, learns the format, and READ OUR INTERNAL WRAPPER ALOUD to a
// caller. The proof call sent every injection as role:'user' and the wrapper was never
// voiced (P4 in PROOF-direct-socket-all4-passed.log). The outbound grammar therefore
// carries `role` as the LITERAL TYPE "user" — a role:'model' injection is a COMPILE
// error (pinned type-level in voice-direct-events.ts, where `npm run typecheck` sees
// it), and these runtime pins hold the builders to the same shape.
//
// THE 1007 FAMILY'S FIFTH MEMBER: `speechConfig.languageCode` is a socket-kill (1007)
// on native audio. The config builder's OUTPUT TYPE has no field that could carry it —
// pinned type-level in src — and E4 deep-scans the built value so a future "just spread
// the caller's options in" refactor goes red at runtime too.
import { describe, it, expect } from "vitest";
import {
  contextTurn,
  directiveTurn,
  buildDirectConnectConfig,
} from "../src/voice-direct-events.js";

/** Every key reachable in a value, depth-first — the runtime half of the languageCode
 *  ban (the type-level half lives in src where typecheck runs). */
function keysDeep(v: unknown, acc: string[] = []): string[] {
  if (v !== null && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      acc.push(k);
      keysDeep(val, acc);
    }
  }
  return acc;
}

describe("outbound turn builders — user-role only, by construction", () => {
  it("E1: contextTurn appends without triggering a response (role user, turnComplete false)", () => {
    // VACUOUS IF only turnComplete were asserted: the leak mechanism is the ROLE, and a
    // builder emitting role:'model' with turnComplete:false is exactly the plugin's bug
    // shape. Pin role, text verbatim, and the single-turn/single-part shape the proof
    // call sent (PROOF-spike.ts:262-265).
    const t = contextTurn("<CALL_CONTEXT>calling about Riverside Heights</CALL_CONTEXT>");
    expect(t.turnComplete).toBe(false);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]!.role).toBe("user");
    expect(t.turns[0]!.parts).toEqual([
      { text: "<CALL_CONTEXT>calling about Riverside Heights</CALL_CONTEXT>" },
    ]);
  });

  it("E2: directiveTurn closes the turn (role user, turnComplete true, text verbatim)", () => {
    // VACUOUS IF text were only substring-matched: a builder that wraps the directive in
    // extra prose here would smuggle unapproved words into the model's mouth — exact
    // part equality is the pin. (The SPEECH layer owns wrapping; this builder does not.)
    const t = directiveTurn("Greet the caller now.");
    expect(t.turnComplete).toBe(true);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]!.role).toBe("user");
    expect(t.turns[0]!.parts).toEqual([{ text: "Greet the caller now." }]);
  });
});

describe("buildDirectConnectConfig — the proof call's winning config, languageCode-proof", () => {
  it("E3: carries the four load-bearing pieces the proof call connected with", () => {
    // Audio out, the system prompt, and BOTH-side transcription — the raw replacement
    // for the plugin's transcription events AND the delivery record (PROOF-spike.ts:
    // 103-110). VACUOUS IF transcription were asserted merely truthy-or-absent: losing
    // `inputAudioTranscription: {}` silently blinds the TurnAssembler and the delivery
    // record at once, so pin the keys' presence explicitly.
    const cfg = buildDirectConnectConfig({
      systemInstruction: "You are a friendly intake assistant.",
      tools: [{ functionDeclarations: [{ name: "search_knowledge" }] }],
    });
    expect(cfg.responseModalities).toEqual(["AUDIO"]);
    expect(cfg.systemInstruction).toBe("You are a friendly intake assistant.");
    expect(cfg.inputAudioTranscription).toEqual({});
    expect(cfg.outputAudioTranscription).toEqual({});
    expect(cfg.tools).toEqual([{ functionDeclarations: [{ name: "search_knowledge" }] }]);
  });

  it("E4: CANNOT emit speechConfig.languageCode — even when a voice is configured", () => {
    // The fifth member of the 1007 family: languageCode on native audio kills the
    // socket. VACUOUS IF built WITHOUT a voiceName: speechConfig would be absent and an
    // empty scan passes with the guard deleted — the voiceName is what forces the
    // speechConfig branch to actually exist, and the positive voiceName assertion
    // proves the scan looked at a real speechConfig rather than nothing.
    const cfg = buildDirectConnectConfig({
      systemInstruction: "prompt",
      voiceName: "Aoede",
    });
    const keys = keysDeep(cfg);
    expect(keys).toContain("voiceName"); // the speechConfig branch is really there…
    expect(keys).not.toContain("languageCode"); // …and cannot carry the killer field
    expect(cfg.speechConfig).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
    });
  });

  it("E5: omits speechConfig entirely when no voice is named — never an empty stub", () => {
    // An empty `speechConfig: {}` is exactly the kind of "harmless" object a later
    // merge decorates with a languageCode. Absent field, not empty object. VACUOUS IF
    // asserted with toBeFalsy: `undefined` vs `{}` is the whole point.
    const cfg = buildDirectConnectConfig({ systemInstruction: "prompt" });
    expect("speechConfig" in cfg && cfg.speechConfig !== undefined).toBe(false);
  });
});
