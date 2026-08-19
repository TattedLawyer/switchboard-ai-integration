/**
 * The knowledge base's Postgres surface — the query side of migration 023's contract.
 *
 * 🚨 FAIL-CLOSED, and the filter IS the contract: a chunk with a NULL `embedding` has
 * not been embedded and therefore DOES NOT EXIST to retrieval, however well its text
 * would have matched. Without the filter, `order by embedding <=> $q` ranks NULL rows
 * NULLS-LAST but still RETURNS them inside a generous limit — half-embedded knowledge
 * silently padding answers, the exact degradation family the C6 plan pins against.
 * Pinned in crm/test/kb-store.test.ts, verified by mutation.
 *
 * Runs as `switchboard_crm` (SELECT on both kb tables, 023's grant block); the same
 * daemon that embeds is the one that will retrieve, so this module lives beside the
 * embedder in the CRM workspace.
 */
import type pg from "pg";
import { EMBED_DIM } from "./dimensions.js";

export interface RetrievedChunk {
  chunkId: string;
  entryId: string;
  ordinal: number;
  kind: string;
  title: string;
  text: string;
  /** When the broker last saved the entry this chunk came from — the staleness signal
   *  the call path's KnowledgePassage carries to the agent. */
  updatedAt: Date;
  /** Cosine distance (`<=>`): 0 = identical direction, 1 = orthogonal, 2 = opposite. */
  distance: number;
}

/**
 * pgvector's input literal: `[x1,x2,…]`. Numbers only — a NaN/Infinity would serialize
 * to something the server rejects, and rightly; refuse it here with a named error so the
 * failure names the vector, not a SQL syntax position.
 */
export function toVectorLiteral(v: readonly number[]): string {
  for (const x of v) {
    if (!Number.isFinite(x)) {
      throw new Error(`kb: vector contains a non-finite component (${x}) — refusing to serialize`);
    }
  }
  return `[${v.join(",")}]`;
}

/**
 * Nearest active chunks to a query embedding, nearest first.
 *
 * The arity is checked BEFORE SQL: the column's `vector(1024)` would reject a wrong-size
 * vector anyway (migration 023's pin), but for the DISTANCE operator a mismatch surfaces
 * as a runtime SQL error mid-query — this pre-flight names the real cause instead.
 */
export async function searchGeneralChunks(
  db: pg.Pool | pg.PoolClient,
  tenantId: string,
  queryEmbedding: readonly number[],
  limit: number,
): Promise<RetrievedChunk[]> {
  if (queryEmbedding.length !== EMBED_DIM) {
    throw new Error(
      `kb: query embedding has ${queryEmbedding.length} dimensions; the store is pinned to ` +
        `${EMBED_DIM} (migration 023, vector(${EMBED_DIM})). A different model is a schema ` +
        `decision, not a call-site one.`,
    );
  }
  const r = await db.query(
    `select c.id        as chunk_id,
            c.entry_id  as entry_id,
            c.ordinal   as ordinal,
            e.kind      as kind,
            e.title     as title,
            e.updated_at as updated_at,
            c.text      as text,
            (c.embedding <=> $2::vector) as distance
       from kb.general_chunks c
       join kb.general_entries e on e.id = c.entry_id
      where e.tenant_id = $1
        and e.status = 'active'
        and c.embedding is not null
      order by c.embedding <=> $2::vector
      limit $3`,
    [tenantId, toVectorLiteral(queryEmbedding), limit],
  );
  return r.rows.map((row) => ({
    chunkId: row.chunk_id as string,
    entryId: row.entry_id as string,
    ordinal: row.ordinal as number,
    kind: row.kind as string,
    title: row.title as string,
    updatedAt: row.updated_at as Date,
    text: row.text as string,
    distance: Number(row.distance),
  }));
}
