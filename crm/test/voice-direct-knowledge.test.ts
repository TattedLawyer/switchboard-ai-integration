// search_knowledge tool-layer pins (KT1–KT9) — the direct-socket path to the broker's
// knowledge base. The zero-tools guard that kept the LIVE worker away from lookups was a
// guard against agents-js #2249 (a PLUGIN-path mic wedge); the proof call ran a mid-call
// tool round-trip on the raw socket and the mic SURVIVED (P3:
// PROOF-direct-socket-all4-passed.log :203-204 tool-call → tool-resp, then :229+ the
// caller heard and transcribed AGAIN), so this layer finally wires
// `CallContext.lookupKnowledge`'s substance to a live call.
//
// The caps are AgenticYap's production values (3 passages × 800 chars, whole response
// clamped ~8000 chars) and the per-call budget mirrors KNOWLEDGE_LOOKUP_CAP — imported
// from executor.ts, not copied, so the two paths cannot drift apart silently.
//
// FAIL-SOFT is the executor's own doctrine verbatim (executor.ts K7): a live human is
// on the line — a broken knowledge base degrades the ANSWER, never the CALL.
import { describe, it, expect } from "vitest";
import { KNOWLEDGE_LOOKUP_CAP } from "../src/executor.js";
import {
  SEARCH_KNOWLEDGE_TOOL,
  KNOWLEDGE_PASSAGES_PER_LOOKUP,
  KNOWLEDGE_PASSAGE_CHAR_CAP,
  KNOWLEDGE_RESPONSE_CHAR_CAP,
  createSearchKnowledgeHandler,
  type KnowledgeResultPassage,
} from "../src/voice-direct-knowledge.js";

function passagesOf(n: number, textLen: number, titleLen = 12): KnowledgeResultPassage[] {
  return Array.from({ length: n }, (_, i) => ({
    text: `${i}<`.padEnd(textLen, "x"),
    title: `title-${i}`.padEnd(titleLen, "t"),
    kind: "faq",
  }));
}

describe("the declaration — the simplest schema that still proves the round-trip", () => {
  it("KT1: search_knowledge declares a single REQUIRED string parameter, `query`", () => {
    // The proof call's tool had ZERO parameters (PROOF-spike.ts:111-120) — the simplest
    // schema that could round-trip; production needs exactly one more: the query. More
    // parameters is more surface for the model to hallucinate arguments into. VACUOUS
    // IF only the name were pinned: the required-array and the property set are the
    // parts a drive-by "helpful" parameter addition would change.
    expect(SEARCH_KNOWLEDGE_TOOL.functionDeclarations).toHaveLength(1);
    const decl = SEARCH_KNOWLEDGE_TOOL.functionDeclarations[0]!;
    expect(decl.name).toBe("search_knowledge");
    expect(decl.parameters?.type).toBe("OBJECT");
    expect(Object.keys(decl.parameters?.properties ?? {})).toEqual(["query"]);
    expect(decl.parameters?.properties?.query?.type).toBe("STRING");
    expect(decl.parameters?.required).toEqual(["query"]);
  });
});

describe("the handler — capped, clamped, batched, fail-soft", () => {
  it("KT2: one call → ONE batched response; id and name echoed; response IS an object", async () => {
    // Gemini's contract: functionResponse.response must be an OBJECT (a bare string is
    // rejected), ids must echo, and all responses to one toolCall message ride in ONE
    // sendToolResponse (the AgenticYap pattern the proof call reused —
    // PROOF-spike.ts:247-255). VACUOUS IF the id were not asserted: an un-echoed id
    // orphans the call server-side and the model waits forever.
    const handler = createSearchKnowledgeHandler(async () => passagesOf(2, 40));
    const batch = await handler([
      { id: "function-call-118981", name: "search_knowledge", args: { query: "office hours" } },
    ]);
    expect(batch.functionResponses).toHaveLength(1);
    const r = batch.functionResponses[0]!;
    expect(r.id).toBe("function-call-118981");
    expect(r.name).toBe("search_knowledge");
    expect(typeof r.response).toBe("object");
    expect(Array.isArray((r.response as { results: unknown }).results)).toBe(true);
  });

  it("KT3: passages are capped at 3 × 800 chars — tested with input LONGER than both caps", async () => {
    // AgenticYap production values. VACUOUS IF the fake returned passages already under
    // the caps (a deleted clamp passes on compliant input): five passages of 10_000
    // chars force BOTH clamps to actually cut, and the content prefix is asserted so
    // 'clamped' cannot be satisfied by returning empty strings.
    const handler = createSearchKnowledgeHandler(async () => passagesOf(5, 10_000));
    const batch = await handler([{ id: "c1", name: "search_knowledge", args: { query: "q" } }]);
    const results = (batch.functionResponses[0]!.response as {
      results: Array<{ text: string }>;
    }).results;
    expect(KNOWLEDGE_PASSAGES_PER_LOOKUP).toBe(3);
    expect(KNOWLEDGE_PASSAGE_CHAR_CAP).toBe(800);
    expect(results).toHaveLength(3);
    for (const [i, r] of results.entries()) {
      expect(r.text).toHaveLength(800);
      expect(r.text.startsWith(`${i}<`)).toBe(true); // clamped, not replaced
    }
  });

  it("KT4: the WHOLE response is clamped ~8000 chars by dropping trailing passages", async () => {
    // Even clamped passages can ride oversize metadata (a monster title). The whole-
    // response clamp is what actually bounds the bytes the socket carries. VACUOUS IF
    // the input serialized under 8000 already: three 4000-char titles force the drop,
    // and the surviving passage is asserted to be the FIRST (relevance order — dropping
    // from the front would keep the worst match).
    const oversized: KnowledgeResultPassage[] = Array.from({ length: 3 }, (_, i) => ({
      text: `${i}-`.padEnd(900, "x"),
      title: `T${i}-`.padEnd(4_000, "t"),
      kind: "faq",
    }));
    const handler = createSearchKnowledgeHandler(async () => oversized);
    const batch = await handler([{ id: "c1", name: "search_knowledge", args: { query: "q" } }]);
    const response = batch.functionResponses[0]!.response as {
      results: Array<{ title: string }>;
      truncated?: boolean;
    };
    expect(JSON.stringify(response).length).toBeLessThanOrEqual(KNOWLEDGE_RESPONSE_CHAR_CAP);
    expect(response.results.length).toBeGreaterThan(0); // clamped, not emptied
    expect(response.results[0]!.title.startsWith("T0-")).toBe(true);
    expect(response.truncated).toBe(true);
  });

  it("KT5: the per-call budget mirrors KNOWLEDGE_LOOKUP_CAP — the 3rd succeeds, the 4th is capped", async () => {
    // The executor's cap doctrine on the direct path: a caller who keeps asking gets an
    // honest handoff, not an unbounded Q&A session on her phone bill. VACUOUS IF only
    // the 4th call were asserted (an off-by-one that caps at 2 would pass): the 3rd
    // call's SUCCESS is the boundary's other face. Also pins that the capped refusal
    // does not reach the store at all — the lookup count stops at the cap.
    let lookups = 0;
    const handler = createSearchKnowledgeHandler(async () => {
      lookups += 1;
      return passagesOf(1, 40);
    });
    expect(KNOWLEDGE_LOOKUP_CAP).toBe(3);
    for (let i = 0; i < KNOWLEDGE_LOOKUP_CAP; i += 1) {
      const batch = await handler([{ id: `c${i}`, name: "search_knowledge", args: { query: "q" } }]);
      const resp = batch.functionResponses[0]!.response as { results: unknown[]; error?: string };
      expect(resp.results).toHaveLength(1); // the 3rd still succeeds
      expect(resp.error).toBeUndefined();
    }
    const fourth = await handler([{ id: "c3", name: "search_knowledge", args: { query: "q" } }]);
    const resp = fourth.functionResponses[0]!.response as { results: unknown[]; error?: string };
    expect(resp.results).toEqual([]);
    expect(resp.error).toMatch(/cap|budget|limit/i);
    expect(lookups).toBe(KNOWLEDGE_LOOKUP_CAP); // the 4th never touched the store
  });

  it("KT6: a throwing lookup yields {error, results: []} — the call survives, the budget is spent", async () => {
    // executor.ts K7 verbatim: fail-SOFT, and the failed attempt still counts against
    // the cap (the cap bounds work ATTEMPTED — a broken store must not be hammered
    // mid-call). VACUOUS IF the handler's promise were only checked to resolve: the
    // budget accounting after failures is what a 'reset on error' mutation breaks —
    // two failures + one success must leave exactly zero budget.
    let calls = 0;
    const handler = createSearchKnowledgeHandler(async () => {
      calls += 1;
      if (calls <= 2) throw new Error("embedder is down");
      return passagesOf(1, 40);
    });
    for (let i = 0; i < 2; i += 1) {
      const batch = await handler([{ id: `f${i}`, name: "search_knowledge", args: { query: "q" } }]);
      const resp = batch.functionResponses[0]!.response as { results: unknown[]; error?: string };
      expect(resp.results).toEqual([]);
      expect(resp.error).toMatch(/embedder is down/);
    }
    const third = await handler([{ id: "ok", name: "search_knowledge", args: { query: "q" } }]);
    expect((third.functionResponses[0]!.response as { results: unknown[] }).results).toHaveLength(1);
    const fourth = await handler([{ id: "over", name: "search_knowledge", args: { query: "q" } }]);
    expect((fourth.functionResponses[0]!.response as { error?: string }).error).toMatch(
      /cap|budget|limit/i,
    );
  });

  it("KT7: two calls in one toolCall message → ONE batch, both answered, both budgeted", async () => {
    // One batched sendToolResponse per toolCall message — the mic-survival pattern.
    // VACUOUS IF order/ids were not asserted pairwise: a handler that answers only the
    // first call (or crosses the ids) still returns 'a batch'.
    let lookups = 0;
    const handler = createSearchKnowledgeHandler(async ({ text }) => {
      lookups += 1;
      return [{ text: `about ${text}`, title: "t", kind: "faq" }];
    });
    const batch = await handler([
      { id: "a", name: "search_knowledge", args: { query: "hours" } },
      { id: "b", name: "search_knowledge", args: { query: "parking" } },
    ]);
    expect(batch.functionResponses.map((r) => r.id)).toEqual(["a", "b"]);
    expect(lookups).toBe(2);
    const texts = batch.functionResponses.map(
      (r) => (r.response as { results: Array<{ text: string }> }).results[0]!.text,
    );
    expect(texts).toEqual(["about hours", "about parking"]);
  });

  it("KT8: an unknown tool name is answered (id echoed, error object) and costs NO budget", async () => {
    // Every call in the message must be answered or the model hangs waiting — but a
    // tool we never declared is not a lookup attempt and must not spend the caller's
    // budget. VACUOUS IF the follow-up budget probe were dropped: the error response
    // alone cannot show whether the counter moved.
    let lookups = 0;
    const handler = createSearchKnowledgeHandler(async () => {
      lookups += 1;
      return passagesOf(1, 40);
    });
    const batch = await handler([{ id: "x", name: "lookup_office_hours", args: {} }]);
    expect(batch.functionResponses[0]!.id).toBe("x");
    expect((batch.functionResponses[0]!.response as { error?: string }).error).toMatch(/unknown/i);
    expect(lookups).toBe(0);
    // all three budget units still available:
    for (let i = 0; i < KNOWLEDGE_LOOKUP_CAP; i += 1) {
      const b = await handler([{ id: `c${i}`, name: "search_knowledge", args: { query: "q" } }]);
      expect((b.functionResponses[0]!.response as { error?: string }).error).toBeUndefined();
    }
  });

  it("KT9: a malformed query (missing / non-string) is refused without spending budget", async () => {
    // The model owns the arguments; a hallucinated shape must degrade to an error the
    // model can recover from, never a crash and never a spent lookup. VACUOUS IF only
    // one malformation were driven: missing args and a non-string query are different
    // failure shapes, and the store must see NEITHER.
    let lookups = 0;
    const handler = createSearchKnowledgeHandler(async () => {
      lookups += 1;
      return passagesOf(1, 40);
    });
    const missing = await handler([{ id: "m", name: "search_knowledge" }]);
    expect((missing.functionResponses[0]!.response as { error?: string }).error).toMatch(/query/i);
    const wrong = await handler([{ id: "w", name: "search_knowledge", args: { query: 42 } }]);
    expect((wrong.functionResponses[0]!.response as { error?: string }).error).toMatch(/query/i);
    expect(lookups).toBe(0);
  });
});
