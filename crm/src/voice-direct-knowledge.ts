// The search_knowledge tool layer — the direct-socket path that finally wires the
// broker's knowledge base to a LIVE call.
//
// WHY THIS CAN EXIST NOW: the live worker's zero-tools rule was a guard against
// agents-js #2249, where a tool round-trip on the PLUGIN path can wedge Gemini Live's
// mic permanently (voice-agent-session.ts:34-48 — the deferred register records the
// gap). The proof call ran a mid-call tool round-trip on the RAW socket and the mic
// SURVIVED: tool-call → tool-resp at 86847ms, the agent spoke the result, and the
// caller was heard and transcribed AGAIN afterwards (P3,
// PROOF-direct-socket-all4-passed.log:203-232). #2249 is a plugin defect, not a
// protocol one — this layer is the counter-proof made production shape.
//
// THE DISPATCH PATTERN is the AgenticYap one the proof call reused (PROOF-spike.ts:
// 246-255): dispatch inline, respond with ONE batched message per toolCall message,
// every id echoed, and every `response` an OBJECT — Gemini rejects a bare string, and
// an un-echoed id orphans the call server-side with the model waiting forever.
//
// THE CAPS are AgenticYap's production values (3 passages × 800 chars, the whole
// response clamped ~8000 chars): a voice agent reads ONE spoken answer's worth of
// material, and everything past that is tokens billed to read aloud to nobody. The
// per-call BUDGET mirrors the executor's — imported, not copied, so the scripted path
// (executor.ts:327) and this live path cannot drift apart silently — and it lives in
// the HANDLER instance (constructed once per call) for the same reason the executor
// keeps its counter out of the kb factory: it is call-lifecycle state.
//
// FAIL-SOFT is executor.ts K7 verbatim: a live human is on the line — a broken
// knowledge base degrades the ANSWER ({error, results: []} — the model says "I can't
// check that right now"), never the CALL. And the failed attempt still counts against
// the budget: the cap bounds work ATTEMPTED, and a broken store must not be hammered
// mid-call.
import { KNOWLEDGE_LOOKUP_CAP } from "./executor.js";
import type { DirectToolCall, DirectToolDeclaration } from "./voice-direct-events.js";

/** AgenticYap production: how many passages one spoken answer can actually use. Equals
 *  the kb layer's DEFAULT_LOOKUP_TOP_K (kb/lookup.ts:35) — same judgment, same value. */
export const KNOWLEDGE_PASSAGES_PER_LOOKUP = 3;

/** AgenticYap production: per-passage character clamp. */
export const KNOWLEDGE_PASSAGE_CHAR_CAP = 800;

/** AgenticYap production: the whole serialized response stays under this — the bound on
 *  what one tool response may push into the model's context mid-call. */
export const KNOWLEDGE_RESPONSE_CHAR_CAP = 8_000;

/** What the model receives per passage — the spoken-answer slice of `KnowledgePassage`
 *  (executor.ts): text, title, kind. Provenance fields (entryId, distance, updatedAt)
 *  stay BELOW this seam — the model has no business reading store internals aloud, and
 *  every extra field is response bytes billed against the 8000 clamp. Structural, so
 *  the real `LookupKnowledge` return type satisfies it unchanged. */
export interface KnowledgeResultPassage {
  text: string;
  title: string;
  kind: string;
}

export interface DirectFunctionResponse {
  id?: string;
  name?: string;
  /** MUST be an object — Gemini's contract (see the header). */
  response: Record<string, unknown>;
}

/** ONE batched reply per toolCall message — the mic-survival pattern. */
export interface DirectToolResponseBatch {
  functionResponses: DirectFunctionResponse[];
}

/**
 * The declaration the connect config carries: a single REQUIRED string, `query`. The
 * proof call's tool had zero parameters — the simplest schema that could round-trip;
 * production needs exactly one more, and no others: every additional parameter is
 * surface for the model to hallucinate arguments into.
 */
export const SEARCH_KNOWLEDGE_TOOL: DirectToolDeclaration = {
  functionDeclarations: [
    {
      name: "search_knowledge",
      description:
        "Search the broker's saved knowledge base for facts relevant to the caller's " +
        "question. Answer ONLY from the returned passages — never guess. An empty " +
        "result means the information is not available on this call.",
      parameters: {
        type: "OBJECT",
        properties: {
          query: {
            type: "STRING",
            description: "What the caller wants to know, as a short search query.",
          },
        },
        required: ["query"],
      },
    },
  ],
};

/**
 * Build the per-call handler: toolCalls[] in, ONE batched response out. The `lookup` is
 * structural — the worker passes its retrieval closure (tenant-bound below the seam,
 * exactly like `knowledgeLookup`'s factory), tests pass fakes. The budget counter lives
 * in this closure: one handler per call, so the counter dies with the call.
 */
export function createSearchKnowledgeHandler(
  lookup: (q: { text: string; topK?: number }) => Promise<KnowledgeResultPassage[]>,
  budget: number = KNOWLEDGE_LOOKUP_CAP,
): (calls: DirectToolCall[]) => Promise<DirectToolResponseBatch> {
  let lookupsUsed = 0;

  const answerOne = async (call: DirectToolCall): Promise<Record<string, unknown>> => {
    if (call.name !== "search_knowledge") {
      // Answered, never dropped — an unanswered id leaves the model waiting forever —
      // but a tool we never declared is not a lookup attempt: it costs NO budget.
      return { error: `unknown tool ${JSON.stringify(call.name ?? "(unnamed)")}`, results: [] };
    }
    const query = call.args?.["query"];
    if (typeof query !== "string" || query.trim() === "") {
      // The model owns the arguments; a hallucinated shape degrades to an error it can
      // recover from — and the store sees nothing, so the budget is untouched.
      return { error: "search_knowledge requires a non-empty string `query`", results: [] };
    }
    if (lookupsUsed >= budget) {
      // The cap refusal costs nothing and consumes nothing (the executor's own rule,
      // executor.ts:327-334): the store is never reached, and the model is TOLD, so it
      // can hand off instead of re-asking.
      return {
        error:
          `knowledge lookup budget exhausted for this call (cap ${budget}) — offer to ` +
          `have someone follow up instead of checking again`,
        results: [],
      };
    }
    lookupsUsed += 1; // attempts count, successes and failures alike (K7's accounting)
    try {
      const passages = await lookup({ text: query, topK: KNOWLEDGE_PASSAGES_PER_LOOKUP });
      const results = passages.slice(0, KNOWLEDGE_PASSAGES_PER_LOOKUP).map((p) => ({
        title: p.title,
        kind: p.kind,
        text: p.text.slice(0, KNOWLEDGE_PASSAGE_CHAR_CAP),
      }));
      const response: { results: typeof results; truncated?: boolean } = { results };
      // The whole-response clamp: drop trailing passages (relevance order — the FIRST
      // is the best match and survives longest) until the serialized bytes fit.
      while (
        results.length > 0 &&
        JSON.stringify(response).length > KNOWLEDGE_RESPONSE_CHAR_CAP
      ) {
        results.pop();
        response.truncated = true;
      }
      return response;
    } catch (err) {
      // FAIL-SOFT (executor.ts K7): the call survives a broken store; the model gets an
      // honest error to phrase around; the budget notes the attempt.
      return { error: err instanceof Error ? err.message : String(err), results: [] };
    }
  };

  return async (calls) => {
    // SEQUENTIAL, deliberately: the budget must be charged in call order (a Promise.all
    // would race the counter), and the store underneath is one embedder + one pool —
    // parallel lookups buy latency variance, not speed.
    const functionResponses: DirectFunctionResponse[] = [];
    for (const call of calls) {
      functionResponses.push({ id: call.id, name: call.name, response: await answerOne(call) });
    }
    return { functionResponses };
  };
}
