// Call vendor (T16) — the BRIDGE between the two processes a real call spans.
//
// A LiveKit call is TWO processes: the executor daemon (which dispatches the agent and
// creates the SIP participant via `livekitPlaceCall`) and the agent worker (a separate
// `@livekit/agents` process that joins the room and runs the conversation — see
// `voice-agent/worker.ts` and its header for why it is not in this workspace). They talk
// over two vendor-provided string channels, and this file is the ONLY definition of what
// travels on them:
//
//   OUT  — job metadata: `agentDispatch.createDispatch(room, agent, { metadata })` puts a
//          plain string on `ctx.job.metadata` (may be empty; 512 KiB limit — both are
//          LiveKit's documented contract). NOTE: `participantMetadata` does NOT reach
//          `ctx.job.metadata`; only dispatch metadata does.
//   BACK — the report: the worker publishes its final RAW signals as room metadata
//          (`roomService.updateRoomMetadata`), which the transport polls. Raw signals
//          only: `disposition.ts` remains the sole authority on what they MEAN
//          (call-transport.ts contract rule 3).
//
// Both sides parse with the SAME strict zod grammar, so the two processes cannot drift —
// the same one-grammar doctrine as `parsePayload` on the approval door. Parsing is LOUD:
// an empty or malformed string is a refusal, never a default, because a worker that
// shrugs at garbage runs a call with no questions and no touch to persist into.
import { z } from "zod";
import type { ConversationOutcome } from "./disposition.js";

// ═══ THE AMD VOCABULARY BOUNDARY ════════════════════════════════════════════════════════

/** LiveKit `voice.AMD`'s category vocabulary (Node agents SDK). Typed openly on purpose:
 *  a vendor upgrade can add categories, and the mapping below must degrade honestly. */
export type LiveKitAmdCategory =
  | "human"
  | "machine-ivr"
  | "machine-vm"
  | "machine-unavailable"
  | "uncertain"
  | (string & {});

/**
 * The ONE translation from the vendor's AMD vocabulary to this repo's raw `amdResult`
 * (`disposition.ts`'s `AmdResult`). It lives here — on the worker's side of the seam —
 * so the transport never interprets AMD at all; it only carries what the worker reported.
 *
 * 🚨 `uncertain` NEVER BECOMES `"human"`. disposition.ts pins exactly this trap: an
 * inconclusive AMD is not evidence of a human, and 200 + "unknown" resolves to
 * `unknown_answer`, never to a successful contact. The same rule covers any category this
 * mapping does not recognise (a vendor rename or addition): honest ignorance, loudly
 * logged by the worker, never a claimed human.
 *
 * `machine-ivr` maps to `"human"` deliberately (LiveKit's own guidance): an IVR is a
 * system a caller navigates live, not a voicemail box to be marked `voicemail`.
 */
export function mapAmdCategory(category: LiveKitAmdCategory): "human" | "machine" | "unknown" {
  switch (category) {
    case "human":
    case "machine-ivr":
      return "human";
    case "machine-vm":
    case "machine-unavailable":
      return "machine";
    default:
      return "unknown";
  }
}

// ═══ OUT: THE JOB METADATA ══════════════════════════════════════════════════════════════

/** LiveKit's documented cap on job metadata. Enforced at ENCODE time so an oversize
 *  question set is our loud error at dispatch, not a vendor-side truncation discovered as
 *  a worker that cannot parse its job. */
export const JOB_METADATA_MAX_BYTES = 512 * 1024;

const promptSchema = z
  .object({
    id: z.string().min(1),
    questionKey: z.string().min(1),
    promptText: z.string().min(1),
  })
  .strict();

const callJobMetadataSchema = z
  .object({
    /** Grammar version. Bump on any breaking change, and keep the worker's parse loud. */
    v: z.literal(1),
    /** The touch `executeCall` opened before dialling — where every answer lands. */
    touchId: z.string().min(1),
    contactId: z.string().min(1),
    /** Null is the nameless path (§5.6). The worker never invents a name. */
    displayName: z.string().nullable(),
    /** `payload.opening_line`, VERBATIM — she approved those words (contract rule 4). */
    openingLine: z.string().min(1),
    /** The approved question list, in order. Also the `bound` set for `recordAnswer`. */
    prompts: z.array(promptSchema),
  })
  .strict();

export type CallJobMetadata = z.infer<typeof callJobMetadataSchema>;

export function encodeCallJobMetadata(job: CallJobMetadata): string {
  const s = JSON.stringify(callJobMetadataSchema.parse(job));
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes > JOB_METADATA_MAX_BYTES) {
    throw new Error(
      `call job metadata is ${bytes} bytes — over LiveKit's 512 KiB dispatch-metadata ` +
        `limit; refusing to dispatch a job the worker would receive truncated`,
    );
  }
  return s;
}

export function parseCallJobMetadata(raw: string): CallJobMetadata {
  if (raw.trim() === "") {
    throw new Error(
      "job metadata is empty — this job was not dispatched by livekitPlaceCall " +
        "(ctx.job.metadata may legitimately be empty on foreign dispatches; refusing it " +
        "is the point: no touch id means nowhere to persist answers)",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`job metadata is not JSON: ${raw.slice(0, 120)}`);
  }
  const r = callJobMetadataSchema.safeParse(parsed);
  if (!r.success) {
    throw new Error(
      `job metadata does not fit the v1 grammar: ` +
        r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  return r.data;
}

// ═══ BACK: THE REPORT ═══════════════════════════════════════════════════════════════════

const conversationOutcomeSchema = z.enum([
  "identity_confirmed_complete",
  "identity_confirmed_cut_off",
  "not_the_contact",
  "identity_not_asked_complete",
  "identity_not_asked_cut_off",
]) satisfies z.ZodType<ConversationOutcome>;

const agentCallReportSchema = z
  .object({
    v: z.literal(1),
    /** ALREADY in this repo's raw vocabulary — the worker maps (`mapAmdCategory`), the
     *  transport carries. A vendor word here ("machine-vm") is a grammar error. */
    amdResult: z.enum(["human", "machine", "unknown"]),
    /** The worker's raw conversational claim, or null when it can claim nothing (e.g. a
     *  voicemail). `disposition.ts` alone decides what any of these MEAN. */
    conversation: conversationOutcomeSchema.nullable(),
    /** Informational, for the executor's log line — persistence already happened per turn
     *  in the worker (guard for agents-js #2157: never persist in a shutdown hook). */
    answersPersisted: z.number().int().nonnegative(),
    reachedOrdinal: z.number().int().nonnegative(),
  })
  .strict();

export type AgentCallReport = z.infer<typeof agentCallReportSchema>;

export function encodeAgentCallReport(report: AgentCallReport): string {
  return JSON.stringify(agentCallReportSchema.parse(report));
}

export function parseAgentCallReport(raw: string): AgentCallReport {
  if (raw.trim() === "") {
    throw new Error("agent call report is empty — the worker published nothing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`agent call report is not JSON: ${raw.slice(0, 120)}`);
  }
  const r = agentCallReportSchema.safeParse(parsed);
  if (!r.success) {
    throw new Error(
      `agent call report does not fit the v1 grammar: ` +
        r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  return r.data;
}
