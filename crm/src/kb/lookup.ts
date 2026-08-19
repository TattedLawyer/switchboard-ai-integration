/**
 * The knowledge seam's implementation — `ExecutorDeps.lookupKnowledge` as retrieval over
 * migration 023's store (plan C6 reaching the call path).
 *
 * 🚨 TENANT-SCOPED IN THE QUERY, BOUND AT CONSTRUCTION. The tenant id is a factory
 * argument, taken once at the composition root; the seam's call signature has no tenant
 * field, so neither the executor nor a vendor adapter can name one — a forged tenant at
 * the call site is unrepresentable, and the WHERE clause in `searchGeneralChunks` is the
 * enforcement (pinned in crm/test/call-knowledge.test.ts K4).
 *
 * 🚨 THE EMBEDDER IS INJECTED, NEVER CONSTRUCTED HERE. `createEmbedder()` is a ~3.5s
 * eager model load meant to run ONCE at process start (embedder.ts's own header);
 * constructing it per lookup would put a multi-second stall into a live phone call.
 * The factory takes anything with `embedQuery` — the REAL vendored model in production,
 * a fake in plumbing tests.
 *
 * 🚨 `embedQuery`, NEVER `embedPassage`. e5's prefix asymmetry is the model's contract
 * (embedder.ts): the caller's QUESTION gets "query: ", her stored text got "passage: "
 * at index time. Swapping them does not error — it silently degrades ranking.
 *
 * FAIL-CLOSED is inherited from the store (`embedding is not null`, `status = 'active'`,
 * tenant filter — all in the one query) and re-pinned at this layer (K5), so a future
 * refactor of either file cannot lose it unnoticed.
 *
 * The per-call CAP does NOT live here — it is call-lifecycle state and belongs to
 * `executeCall` (see KNOWLEDGE_LOOKUP_CAP in executor.ts): this function is constructed
 * once per process and shared across calls, so any counter here would leak across calls.
 */
import type pg from "pg";
import type { KnowledgePassage, LookupKnowledge } from "../executor.js";
import type { Embedder } from "./embedder.js";
import { searchGeneralChunks } from "./store.js";

/** Three passages ≈ what a voice agent can actually use in one spoken answer. */
export const DEFAULT_LOOKUP_TOP_K = 3;
/** An adapter asking for 500 passages is a bug, not a request — clamp, loudly typed. */
export const MAX_LOOKUP_TOP_K = 8;

/** The one method this seam needs — the REAL `Embedder` satisfies it; tests may fake it. */
export type QueryEmbedder = Pick<Embedder, "embedQuery">;

/**
 * The factory the composition root calls once: a pool (running as `switchboard_crm`,
 * whose 023 grants cover exactly the two SELECTs the store query needs), the
 * already-constructed embedder, and the deployment's tenant.
 */
export function knowledgeLookup(
  db: pg.Pool,
  embedder: QueryEmbedder,
  tenantId: string,
): LookupKnowledge {
  return async ({ text, topK }): Promise<KnowledgePassage[]> => {
    const limit = Math.min(
      Math.max(1, Math.trunc(topK ?? DEFAULT_LOOKUP_TOP_K)),
      MAX_LOOKUP_TOP_K,
    );
    const queryEmbedding = await embedder.embedQuery(text);
    const hits = await searchGeneralChunks(db, tenantId, queryEmbedding, limit);
    return hits.map((h) => ({
      text: h.text,
      title: h.title,
      kind: h.kind,
      entryId: h.entryId,
      updatedAt: h.updatedAt,
      distance: h.distance,
    }));
  };
}
