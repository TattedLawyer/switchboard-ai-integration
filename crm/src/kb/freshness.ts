/**
 * The knowledge base's freshness surface — the honest "indexing…" signal for the
 * authoring UI (plan C6). Pure SQL over a pg pool: no tokenizer, no model, no state, so
 * any workspace holding a suitably-granted pool can call it.
 *
 * 🚨 GRANT REALITY (migration 023): the query reads BOTH kb tables. `switchboard_crm`
 * and the migration owner can run it today; `switchboard_approval` — the dashboard's own
 * role — holds NOTHING on `kb.general_chunks`, deliberately ("a compromised dashboard
 * session should not be able to touch a vector" — 023's grant block). Surfacing this
 * signal inside the approval service therefore needs an owner decision (a SELECT grant
 * in a NEW migration, or the signal served across a boundary by a process that holds
 * it); this module does not pre-empt that decision.
 *
 * THE THREE STATES, derived from the embed pass's row-state contract
 * (kb/embed-pass.ts header):
 *   · `not_indexed` — no chunks at all: the daemon has not looked yet.
 *   · `indexing`    — work is owed: a PENDING chunk exists (embedding NULL,
 *                     embedded_at NULL), or the entry was edited after its last vector
 *                     was written (`updated_at > max(embedded_at)` — the same staleness
 *                     clause the embed pass queues on, so this surface and the worker
 *                     never disagree about whether work is owed).
 *   · `indexed`     — the current generation is fully embedded and the text has not
 *                     changed since: retrieval serves exactly what she saved.
 *
 * Retired entries are reported with their mechanical state and `status = 'retired'`;
 * retrieval ignores them regardless (the store filters on status), so the UI should
 * lead with status, not state, for those rows.
 */
import type pg from "pg";

export type KbIndexState = "not_indexed" | "indexing" | "indexed";

export interface KbEntryIndexState {
  entryId: string;
  title: string;
  kind: string;
  status: string;
  chunkCount: number;
  /** Chunks currently carrying a vector — the retrievable ones (if the entry is active). */
  embeddedCount: number;
  /** Current-generation chunks still awaiting their vector. */
  pendingCount: number;
  state: KbIndexState;
}

/** Per-entry indexing state for one tenant, most recently touched first. */
export async function kbIndexStates(
  db: pg.Pool | pg.PoolClient,
  tenantId: string,
): Promise<KbEntryIndexState[]> {
  const r = await db.query(
    `select e.id     as entry_id,
            e.title  as title,
            e.kind   as kind,
            e.status as status,
            count(c.id)::int as chunk_count,
            count(c.embedding)::int as embedded_count,
            (count(*) filter (where c.id is not null
                                and c.embedding is null
                                and c.embedded_at is null))::int as pending_count,
            (e.updated_at > coalesce(max(c.embedded_at), '-infinity'::timestamptz)) as stale
       from kb.general_entries e
       left join kb.general_chunks c on c.entry_id = e.id
      where e.tenant_id = $1
      group by e.id
      order by e.updated_at desc, e.id`,
    [tenantId],
  );
  return r.rows.map((row) => {
    const chunkCount = row.chunk_count as number;
    const pendingCount = row.pending_count as number;
    const state: KbIndexState =
      chunkCount === 0
        ? "not_indexed"
        : pendingCount > 0 || (row.stale as boolean)
          ? "indexing"
          : "indexed";
    return {
      entryId: row.entry_id as string,
      title: row.title as string,
      kind: row.kind as string,
      status: row.status as string,
      chunkCount,
      embeddedCount: row.embedded_count as number,
      pendingCount,
      state,
    };
  });
}
