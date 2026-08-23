// The direct-socket wire grammar — the typed vocabulary the Step-1 worker will speak
// over its OWN @google/genai Live socket, defined here as PLAIN DATA so the compiler and
// the pins can see every shape the wire carries.
//
// 🚨 THE CONTAINMENT RULE THIS FILE EXISTS TO UPHOLD: crm/src/** never imports
// `@livekit/agents`, `@livekit/rtc-node`, or `@google/genai` (the ONNX-stack dependency
// trade recorded in call-transport.ts, extended to the whole vendor surface). These
// types are structural MIRRORS of what the worker translates at the socket boundary —
// the worker passes real objects, tests pass fakes, and every decidable rule about the
// wire lives where a typecheck and a pin can reach it. The field names deliberately
// match the installed @google/genai 2.18.0 declarations (dist/genai.d.ts:9428-9467
// LiveServerContent; :12613-12620 SpeechConfig) so the worker's translation is a rename-
// free projection, but nothing here links against them.
//
// WHY `role` IS THE LITERAL TYPE "user" AND NOT A STRING: the prompt-leak mechanism,
// observed on a live call. The plugin sends its instruction injections as role:'model'
// (agents-plugin-google/src/realtime/realtime_api.ts:900-919); the model treats those as
// its own past speech, learns the format, and READ OUR INTERNAL WRAPPER ALOUD to a
// caller. On gemini-3.1-flash-live a role:'model' client turn is worse still — a
// session-killing 1007 (PROOF-spike.ts:260-261). The winning call (P4 in
// PROOF-direct-socket-all4-passed.log) sent every injection as role:'user' and the
// wrapper was never voiced. With the literal type, a role:'model' injection is a
// COMPILE ERROR — a review catch turned into a build failure.

/** One text part of an outbound client turn. Text only, on purpose: the outbound
 *  content path carries directives and context, never media — audio goes through
 *  `sendRealtimeInput`, which is a different channel with different failure modes. */
export interface DirectUserPart {
  text: string;
}

/** An outbound turn. The `role` is the literal "user" — see the header. */
export interface DirectUserTurn {
  role: "user";
  parts: DirectUserPart[];
}

/** A context injection: appends to the conversation WITHOUT triggering a response
 *  (`turnComplete: false` is what makes it silent — PROOF-spike.ts:262-265). */
export interface ContextTurn {
  turns: DirectUserTurn[];
  turnComplete: false;
}

/** A directive: closes the turn (`turnComplete: true`) so the model responds NOW — the
 *  raw replacement for the plugin's `generateReply()` (PROOF-spike.ts:350-354). */
export interface DirectiveTurn {
  turns: DirectUserTurn[];
  turnComplete: true;
}

/** Build a context injection. ONE turn, ONE part, the text verbatim — the builder adds
 *  nothing, because anything added here would ride into the model's context unapproved. */
export function contextTurn(text: string): ContextTurn {
  return { turns: [{ role: "user", parts: [{ text }] }], turnComplete: false };
}

/** Build a directive. Same single-turn, single-part, verbatim discipline. */
export function directiveTurn(text: string): DirectiveTurn {
  return { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true };
}

// ─── tool declarations (the outbound half of the tool channel) ───────────────────────

/** The subset of Gemini's function-declaration schema this stack uses. The literal
 *  "OBJECT"/"STRING" strings are @google/genai's own `Type` enum VALUES — mirroring the
 *  values instead of importing the enum keeps the containment rule intact. */
export interface DirectFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: {
    type: "OBJECT";
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

export interface DirectToolDeclaration {
  functionDeclarations: DirectFunctionDeclaration[];
}

/** One function call as the server sends it. All fields optional because the wire makes
 *  no promise (the proof call's ids arrived as "function-call-11898…" strings, but the
 *  declarations say `string | undefined`) — the tool layer echoes what exists. */
export interface DirectToolCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

// ─── the inbound event grammar ───────────────────────────────────────────────────────

/**
 * Every server-side event the decidable layer consumes, as one discriminated union —
 * the worker's translation target for `LiveServerMessage`. Each member is the plain-data
 * mirror of the field the winning call actually exercised (log tags in brackets):
 *   · audio               — modelTurn inlineData PCM16@24k, still base64 [first-frame-out]
 *   · inputTranscription  — the CALLER's words, fragment by fragment [transcript-in]
 *   · outputTranscription — the AGENT's words: the delivery record [transcript-out]
 *   · interrupted         — caller barged in; playback queue must clear [interrupted]
 *   · generationComplete  — model finished GENERATING (the dead window's left edge)
 *   · turnComplete        — the turn actually closed (its right edge) [turn-complete]
 *   · toolCalls           — mid-call function calls, answered in ONE batch [tool-call]
 *   · goAway              — the server's imminent-disconnect warning [go-away]
 *   · usage               — token accounting [usage]
 *   · closed              — the socket ended; code 1000 is the only clean one
 *   · error               — the socket's error callback; always latches the channel
 * (`interimInputTranscription` is deliberately NOT carried: it was the spike's
 * diagnostic instrument, not a decision input — nothing decidable may key off interim
 * text that the final transcription can contradict.)
 */
export type DirectInboundEvent =
  | { type: "audio"; base64Pcm16: string }
  | { type: "inputTranscription"; text: string }
  | { type: "outputTranscription"; text: string }
  | { type: "interrupted" }
  | { type: "generationComplete" }
  | { type: "turnComplete" }
  | { type: "toolCalls"; calls: DirectToolCall[] }
  | { type: "goAway"; timeLeftMs?: number }
  | { type: "usage"; promptTokens?: number; responseTokens?: number; totalTokens?: number }
  | { type: "closed"; code: number; reason: string }
  | { type: "error"; message: string };

// ─── the connect config, languageCode-proof by type ──────────────────────────────────

/**
 * 🚨 THE FIFTH MEMBER OF THE 1007 FAMILY: `speechConfig.languageCode` is a socket-kill
 * (1007) on native audio. This type is the ban's enforcement — it has NO field that
 * could carry a language code, so the builder below CANNOT emit one, and neither can
 * any caller that goes through it. (The other four members live in AgenticYap's
 * repro_1007 suite: role:'model' turns on 3.1, odd-byte audio, compression under the
 * fixed prefix, and the model-name mismatches.)
 */
export interface DirectSpeechConfig {
  voiceConfig: { prebuiltVoiceConfig: { voiceName: string } };
}

/** The connect config the worker hands to `ai.live.connect`. Exactly the winning
 *  call's shape (PROOF-spike.ts:102-124): audio out, the system prompt, BOTH-side
 *  transcription (the raw replacement for the plugin's transcription events AND the
 *  delivery record), and the tool declarations. NO contextWindowCompression: on a
 *  bounded intake call it buys nothing, and mis-sized it is 1007 member number three. */
export interface DirectConnectConfig {
  responseModalities: ["AUDIO"];
  systemInstruction: string;
  inputAudioTranscription: Record<string, never>;
  outputAudioTranscription: Record<string, never>;
  speechConfig?: DirectSpeechConfig;
  tools?: DirectToolDeclaration[];
}

export interface DirectConnectConfigInput {
  systemInstruction: string;
  /** A prebuilt voice name. OPTIONAL, and when absent `speechConfig` is OMITTED rather
   *  than sent empty — an empty stub is exactly the object a later merge decorates
   *  with the killer field. */
  voiceName?: string;
  tools?: DirectToolDeclaration[];
}

/** Build the connect config. A projection, not a merge: only the three inputs above can
 *  reach the wire, so no caller can smuggle an arbitrary field past the type. */
export function buildDirectConnectConfig(input: DirectConnectConfigInput): DirectConnectConfig {
  const config: DirectConnectConfig = {
    responseModalities: ["AUDIO"],
    systemInstruction: input.systemInstruction,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
  if (input.voiceName !== undefined) {
    config.speechConfig = {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voiceName } },
    };
  }
  if (input.tools !== undefined) config.tools = input.tools;
  return config;
}

// ─── compile-time pins (checked by `npm run typecheck`, which covers src only) ───────

/** Exact type equality — the standard distributivity-proof encoding. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

/** The role is EXACTLY the literal "user": widening it to `string` (or adding "model"
 *  to a union) breaks this line at typecheck — the leak mechanism cannot be
 *  reintroduced without a red build. */
const _roleIsLiteralUser: Equals<DirectUserTurn["role"], "user"> = true;
void _roleIsLiteralUser;

/** DirectSpeechConfig carries exactly one key, `voiceConfig` — adding `languageCode`
 *  (or anything else) breaks this line at typecheck. */
const _speechConfigCannotCarryLanguageCode: Equals<keyof DirectSpeechConfig, "voiceConfig"> = true;
void _speechConfigCannotCarryLanguageCode;
