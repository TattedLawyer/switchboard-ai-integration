/**
 * The embed pass — the worker that turns her saved knowledge entries into chunks and
 * vectors, so the store (kb/store.ts) can find them (plan C6).
 *
 * 🚨 THE GRANT REALITY SHAPES THE WHOLE DESIGN. `switchboard_crm` (migration 023) holds
 * SELECT on entries, SELECT+INSERT on chunks, and column-level UPDATE on
 * (embedding, embedded_at) ONLY. No DELETE anywhere in `kb`, no UPDATE on
 * `text`/`content_hash`/`ordinal`. So when she EDITS an entry — including edits that
 * produce FEWER chunks than before — the pass can neither rewrite the old rows nor
 * remove them. It SUPERSEDES instead:
 *
 *   · the new text's chunks are inserted as a NEW GENERATION at fresh ordinals
 *     (base = max existing ordinal + 1 — `unique (entry_id, ordinal)` is never re-used);
 *   · in the SAME transaction, every older row's `embedding` is set to NULL — and the
 *     store's `embedding is not null` filter makes NULL mean GONE from retrieval, so no
 *     stale sentence outlives the edit, whatever the old and new chunk counts are;
 *   · the old rows' TEXT stays forever (nothing in `kb` is ever deleted — a retrieval
 *     answer she saw last week must remain explainable this week).
 *
 * CHUNK ROW STATES, readable from (embedding, embedded_at):
 *   · PENDING     embedding NULL, embedded_at NULL — current generation, awaiting vector.
 *     (Exactly migration 023's lifecycle: "a chunk exists the moment the text is chunked,
 *     and becomes searchable only when the local embedder has written its vector.")
 *   · EMBEDDED    embedding NOT NULL — current generation, retrievable.
 *   · SUPERSEDED  embedding NULL, embedded_at NOT NULL — an older generation;
 *     `embedded_at` here records WHEN it was retired from retrieval, so a superseded row
 *     never masquerades as pending and the work queue stays finite.
 *
 * IDEMPOTENT AND RESUMABLE, by construction rather than bookkeeping:
 *   · publish-new-generation is ONE transaction (insert pendings + null old vectors) —
 *     a crash leaves either the old state or a fully-declared pending generation;
 *   · each vector is written by its own UPDATE — a crash mid-embed leaves the remaining
 *     rows PENDING, which the candidate query picks up next pass;
 *   · a finished entry stops matching the candidate query entirely, so a no-change
 *     re-run selects nothing and writes nothing (pinned: embedded_at untouched).
 *
 * THE CANDIDATE QUERY is SQL-only (it walks 023's tenant/status index; the tokenizer
 * never runs for entries with nothing to do): an active entry needs a look when it has
 * no chunks, OR has a PENDING chunk, OR `updated_at > max(embedded_at)`. That last
 * clause is a CONTRACT WITH THE AUTHORING SURFACE: an edit must bump `updated_at`
 * (the column 023 explicitly grants `switchboard_approval` UPDATE on). Once a candidate
 * is in hand, staleness is decided by CONTENT — sha256 of what the chunker would produce
 * now vs the stored `content_hash`es — never by timestamps alone, so a touch that
 * changes no text re-embeds nothing (the trailing generation just gets its
 * `embedded_at` re-stamped to clear candidacy).
 *
 * 🚨 EDIT-DURING-PASS is closed with a snapshot guard, not a lock (`switchboard_crm`
 * cannot `select … for update` on entries — SELECT only): every write is conditioned on
 * `general_entries.updated_at` still equalling the value read at the start of the
 * entry's processing (carried as TEXT both ways — a timestamptz through a JS Date loses
 * microseconds and the equality would silently never hold). If she saves an edit
 * mid-pass, the guard misses, the entry is DEFERRED, and the next pass re-reads the new
 * text. Without the guard, a vector of the OLD body could be stamped fresher than her
 * edit and the staleness clause would never fire again.
 *
 * ONE PASS AT A TIME (advisory lock, sheet-adopt.ts's idiom): two overlapping passes
 * would race the same pendings and collide on `unique (entry_id, ordinal)`; the second
 * pass skips quietly instead. Bounded per pass (`limit`), so a huge backlog cannot stall
 * the reconcile loop — the next tick continues where this one stopped.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import { chunkEntry } from "./chunker.js";
import { toVectorLiteral } from "./store.js";

/** Entries one pass may process. ~145ms/chunk on the real model: 20 entries of a few
 *  chunks each stays well inside the loop's 60s interval. Env: CRM_KB_EMBED_LIMIT. */
export const DEFAULT_KB_EMBED_LIMIT = 20;

/** The advisory-lock key — one per deployment, because the pass already covers every
 *  tenant and generation publishing must never race itself. */
export const KB_EMBED_LOCK_NS = "switchboard.kb_embed";

/** What the pass needs from the embedder — the passage side plus the real tokenizer's
 *  count (the chunker's budget is TOKENS; a stand-in count is a test-only affair). */
export interface KbEmbedDeps {
  embedPassage(text: string): Promise<number[]>;
  countTokens(text: string): number;
}

export interface KbEmbedFailure {
  entryId: string;
  error: string;
}

export interface KbEmbedReport {
  /** true when another pass held the advisory lock — nothing was read or written. */
  skipped: boolean;
  /** Entries the candidate query surfaced this pass (bounded by `limit`). */
  candidates: number;
  /** Entries brought to fully-embedded this pass. */
  entriesEmbedded: number;
  /** Candidates whose text was unchanged (e.g. a title-only edit): no vectors computed,
   *  the current generation's embedded_at re-stamped so candidacy clears. */
  entriesRefreshed: number;
  /** Entries she edited WHILE the pass held them — left untouched for the next pass. */
  entriesDeferred: number;
  chunksEmbedded: number;
  /** Older-generation chunks whose embedding was nulled — retired from retrieval. */
  chunksSuperseded: number;
  /** Per-entry errors. One bad entry never aborts the pass. */
  failures: KbEmbedFailure[];
}

const sha256 = (t: string): string => createHash("sha256").update(t).digest("hex");

interface ChunkRow {
  id: string;
  ordinal: number;
  content_hash: string;
  embedded: boolean;
}

interface EntrySnapshot {
  body: string;
  status: string;
  /** updated_at as Postgres text — microsecond-exact for the write guards. */
  updatedAt: string;
}

/** Per-entry outcome, folded into the report by the pass loop. */
interface EntryOutcome {
  embeddedChunks: number;
  supersededChunks: number;
  kind: "embedded" | "refreshed" | "deferred" | "skipped";
}

async function processEntry(
  db: pg.Pool,
  deps: KbEmbedDeps,
  entryId: string,
): Promise<EntryOutcome> {
  const e = await db.query<{ body: string; status: string; updated_at: string }>(
    `select body, status, updated_at::text as updated_at
       from kb.general_entries where id = $1`,
    [entryId],
  );
  if (e.rows.length === 0 || e.rows[0].status !== "active") {
    // Deleted cannot happen (no role holds DELETE); retired-since-the-candidate-query can.
    return { embeddedChunks: 0, supersededChunks: 0, kind: "skipped" };
  }
  const snap: EntrySnapshot = {
    body: e.rows[0].body,
    status: e.rows[0].status,
    updatedAt: e.rows[0].updated_at,
  };

  const texts = chunkEntry(snap.body, deps.countTokens);
  if (texts.length === 0) {
    // Unreachable while the schema's btrim check holds; named rather than silent.
    throw new Error(`kb embed pass: entry ${entryId} chunked to nothing — refusing to proceed`);
  }
  const hashes = texts.map(sha256);

  const existing = await db.query<ChunkRow>(
    `select id, ordinal, content_hash, (embedding is not null) as embedded
       from kb.general_chunks where entry_id = $1 order by ordinal`,
    [entryId],
  );
  const rows = existing.rows;

  // Does the CURRENT generation — the trailing `texts.length` rows — already carry
  // exactly the chunks the current body produces?
  const trailingStart = rows.length - texts.length;
  const trailingMatches =
    trailingStart >= 0 && hashes.every((h, i) => rows[trailingStart + i].content_hash === h);

  let trailing: ChunkRow[];
  let superseded = 0;

  if (trailingMatches) {
    trailing = rows.slice(trailingStart);
    // Repair arm: an older-generation row still carrying a vector must lose it. With
    // publishing transactional this is unreachable in normal operation; it exists so a
    // damaged state converges instead of persisting.
    const repair = await db.query(
      `update kb.general_chunks
          set embedding = null, embedded_at = now()
        where entry_id = $1 and ordinal < $2 and embedding is not null`,
      [entryId, trailing[0].ordinal],
    );
    superseded += repair.rowCount ?? 0;
  } else {
    // Publish the new generation: pendings inserted and old vectors nulled in ONE
    // transaction, every statement guarded on the updated_at snapshot.
    const base = rows.length === 0 ? 0 : rows[rows.length - 1].ordinal + 1;
    const client = await db.connect();
    try {
      await client.query("begin");
      const inserted: ChunkRow[] = [];
      for (let i = 0; i < texts.length; i++) {
        const r = await client.query<{ id: string }>(
          `insert into kb.general_chunks (entry_id, ordinal, text, content_hash)
           select $1, $2, $3, $4
            where exists (select 1 from kb.general_entries e
                           where e.id = $1 and e.updated_at = $5::timestamptz)
           returning id`,
          [entryId, base + i, texts[i], hashes[i], snap.updatedAt],
        );
        if (r.rows.length === 0) {
          await client.query("rollback");
          return { embeddedChunks: 0, supersededChunks: 0, kind: "deferred" };
        }
        inserted.push({ id: r.rows[0].id, ordinal: base + i, content_hash: hashes[i], embedded: false });
      }
      // Retire every older row from retrieval: embedded rows lose their vector; pending
      // rows of an abandoned generation get STAMPED (embedded_at) so they stop reading
      // as pending. Already-superseded rows are left alone.
      const retire = await client.query(
        `update kb.general_chunks
            set embedding = null, embedded_at = now()
          where entry_id = $1 and ordinal < $2
            and (embedding is not null or embedded_at is null)`,
        [entryId, base],
      );
      superseded += retire.rowCount ?? 0;
      await client.query("commit");
      trailing = inserted;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // Embed whatever in the current generation still lacks a vector — the whole job for a
  // new generation, the remainder for a resumed crash. Each write re-checks the
  // snapshot guard; a mid-pass edit defers the rest to the next pass.
  const textByOrdinal = new Map(trailing.map((row, i) => [row.id, texts[i]]));
  let embeddedChunks = 0;
  for (const row of trailing) {
    if (row.embedded) continue;
    const vector = await deps.embedPassage(textByOrdinal.get(row.id) as string);
    const w = await db.query(
      `update kb.general_chunks c
          set embedding = $1::vector, embedded_at = now()
        where c.id = $2
          and exists (select 1 from kb.general_entries e
                       where e.id = $3 and e.updated_at = $4::timestamptz)`,
      [toVectorLiteral(vector), row.id, entryId, snap.updatedAt],
    );
    if ((w.rowCount ?? 0) === 0) {
      return { embeddedChunks, supersededChunks: superseded, kind: "deferred" };
    }
    embeddedChunks++;
  }

  if (embeddedChunks > 0) {
    return { embeddedChunks, supersededChunks: superseded, kind: "embedded" };
  }

  // Candidate, trailing generation matches, every vector present: the entry was touched
  // without its text changing (title/kind edit, or an edit and revert). Re-stamp the
  // current generation's embedded_at — the vectors still describe this exact text (the
  // content_hash proves it) — so candidacy clears without paying for an embed.
  const bump = await db.query(
    `update kb.general_chunks c
        set embedded_at = now()
      where c.entry_id = $1 and c.ordinal >= $2
        and exists (select 1 from kb.general_entries e
                     where e.id = $1 and e.updated_at = $3::timestamptz)`,
    [entryId, trailing[0].ordinal, snap.updatedAt],
  );
  if ((bump.rowCount ?? 0) === 0) {
    return { embeddedChunks: 0, supersededChunks: superseded, kind: "deferred" };
  }
  return { embeddedChunks: 0, supersededChunks: superseded, kind: "refreshed" };
}

/**
 * One pass: find active entries whose chunks are missing, pending, or stale; chunk,
 * embed, publish. Returns a structured report in `runSheetAdoption`'s idiom. Errors are
 * isolated PER ENTRY — one refusing entry is a report line, never a dead pass.
 */
export async function runKbEmbedPass(
  db: pg.Pool,
  deps: KbEmbedDeps,
  options: { limit?: number } = {},
): Promise<KbEmbedReport> {
  const limit = options.limit ?? DEFAULT_KB_EMBED_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(`kb embed pass: invalid limit ${String(options.limit)} — expected a positive integer`);
  }

  const report: KbEmbedReport = {
    skipped: false,
    candidates: 0,
    entriesEmbedded: 0,
    entriesRefreshed: 0,
    entriesDeferred: 0,
    chunksEmbedded: 0,
    chunksSuperseded: 0,
    failures: [],
  };

  // The lock lives on THIS client's session; crash or disconnect releases it (advisory
  // locks die with the connection — no TTL to mis-tune).
  const lockClient = await db.connect();
  try {
    const lock = await lockClient.query<{ ok: boolean }>(
      `select pg_try_advisory_lock(hashtextextended($1, 0)) as ok`,
      [KB_EMBED_LOCK_NS],
    );
    if (!lock.rows[0].ok) {
      report.skipped = true;
      return report;
    }
    try {
      const candidates = await db.query<{ id: string }>(
        `select e.id
           from kb.general_entries e
          where e.status = 'active'
            and (
              not exists (select 1 from kb.general_chunks c where c.entry_id = e.id)
              or exists (select 1 from kb.general_chunks c
                          where c.entry_id = e.id
                            and c.embedding is null and c.embedded_at is null)
              or e.updated_at > (select max(c.embedded_at) from kb.general_chunks c
                                  where c.entry_id = e.id)
            )
          order by e.updated_at asc, e.id
          limit $1`,
        [limit],
      );
      report.candidates = candidates.rows.length;

      for (const { id } of candidates.rows) {
        try {
          const o = await processEntry(db, deps, id);
          report.chunksEmbedded += o.embeddedChunks;
          report.chunksSuperseded += o.supersededChunks;
          if (o.kind === "embedded") report.entriesEmbedded++;
          else if (o.kind === "refreshed") report.entriesRefreshed++;
          else if (o.kind === "deferred") report.entriesDeferred++;
        } catch (err) {
          report.failures.push({
            entryId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return report;
    } finally {
      await lockClient
        .query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [KB_EMBED_LOCK_NS])
        .catch(() => undefined);
    }
  } finally {
    lockClient.release();
  }
}

/** One log line per pass, the reconcile loop's idiom: quiet when nothing happened. */
export function formatKbEmbedReport(r: KbEmbedReport): string {
  if (r.skipped) return "skipped: another embed pass holds the lock";
  const parts = [
    `${r.candidates} candidate(s)`,
    `${r.entriesEmbedded} embedded`,
    ...(r.entriesRefreshed > 0 ? [`${r.entriesRefreshed} refreshed`] : []),
    ...(r.entriesDeferred > 0 ? [`${r.entriesDeferred} deferred (edited mid-pass)`] : []),
    `${r.chunksEmbedded} chunk vector(s) written`,
    ...(r.chunksSuperseded > 0 ? [`${r.chunksSuperseded} superseded`] : []),
    ...(r.failures.length > 0 ? [`${r.failures.length} FAILED`] : []),
  ];
  return parts.join(", ");
}
