-- 024: the knowledge-base INDEX-STATE view — the dashboard's honest "is it searchable
-- yet?" signal, without moving 023's chunk boundary by one column.
--
-- WHY A NEW FILE. 014-023 are applied and checksum-enforced (src/migrate.ts): editing an
-- applied file makes `runMigrations` refuse. Everything here is new.
--
-- IMPLICITLY TRANSACTIONAL, in 015/016/019/020/021/022/023's idiom: `migrate.ts` submits
-- this file as ONE `client.query(sql)` and it contains no BEGIN/COMMIT — the
-- create-then-grant blocks below leave no window in which the view exists without its
-- role surface.
--
-- WHAT THIS IS. 023 deliberately grants `switchboard_approval` NOTHING on
-- `kb.general_chunks` ("a compromised dashboard session should not be able to touch a
-- vector"), but the authoring page must honestly show whether an entry is searchable yet
-- — and that state lives in the chunks table. This view exposes DERIVED per-entry state
-- only: counts and a three-value verdict, never `embedding`, `text` or `content_hash`.
-- SELECT is granted on the VIEW alone; the base table stays exactly as 023 left it
-- (measured: the base table still answers 42501 to the approval role for every column
-- and for `select *`, and `select embedding from kb.entry_index_state` is 42703 — the
-- column does not exist in any form on the approval role's side of the boundary).
--
-- 🚨 NO `security_invoker`, DELIBERATELY. The whole mechanism depends on the DEFAULT: a
-- view without `security_invoker = true` checks base-table privileges as the view's
-- OWNER (the migration-owner role, which holds them), so `switchboard_approval` can read
-- the derived rows while still holding nothing on `kb.general_chunks`. Setting
-- `security_invoker` would re-check the base tables as the CALLER and turn every
-- dashboard read into the very 42501 the view exists to avoid.
--
-- PER-ENTRY AGGREGATE, NOT PER-CHUNK, on purpose: the dashboard needs one badge per
-- entry, and per-chunk rows would push the superseded-generation subtlety (below) into
-- every consumer. The naive aggregate a consumer would write — "all chunks embedded" as
-- chunk_count = embedded_count — is WRONG the moment an entry has ever been edited,
-- because superseded text is kept forever (023: nothing in `kb` is ever deleted).
--
-- 🚨 THE STATE DERIVES FROM `embedding IS NOT NULL`, NEVER FROM `embedded_at`. The embed
-- pass's row-state contract (crm/src/kb/embed-pass.ts):
--   · PENDING     embedding NULL,     embedded_at NULL
--   · EMBEDDED    embedding NOT NULL
--   · SUPERSEDED  embedding NULL,     embedded_at NOT NULL (stamped at retirement)
-- so `embedded_at` alone cannot tell EMBEDDED from SUPERSEDED, and a view derived from
-- it would count retired generations as live. `count(c.embedding)` counts exactly the
-- rows carrying a vector — the retrievable ones.
--
-- THE THREE STATES mirror crm/src/kb/freshness.ts VERBATIM — same predicates, same
-- names — and the `stale` clause is the embed pass's own candidate clause
-- (`updated_at > max(embedded_at)`), so this surface, the freshness module and the
-- worker can never disagree about whether work is owed:
--   · not_indexed  no chunks at all: the daemon has not looked yet.
--   · indexing     work is owed: a PENDING chunk exists, or the entry was edited after
--                  its last vector was written.
--   · indexed      the current generation is fully embedded and the text has not
--                  changed since: retrieval serves exactly what she saved.
--
-- `tenant_id` and `status` ride along for filtering; both are already readable by the
-- approval role directly on `kb.general_entries` (023's SELECT grant), so they widen
-- nothing. Timestamps for "how long has this been waiting" come from the entries table
-- the dashboard already reads — the view adds no chunk timestamps.
--
-- IDEMPOTENT: `create or replace view`; the grant and revokes re-run harmlessly.

create or replace view kb.entry_index_state as
select e.id        as entry_id,
       e.tenant_id as tenant_id,
       e.status    as status,
       count(c.id)::int        as chunk_count,
       -- count(expr) counts non-NULL: exactly the vector-carrying (retrievable) rows.
       count(c.embedding)::int as embedded_count,
       (count(*) filter (where c.id is not null
                           and c.embedding is null
                           and c.embedded_at is null))::int as pending_count,
       case
         when count(c.id) = 0 then 'not_indexed'
         when (count(*) filter (where c.id is not null
                                  and c.embedding is null
                                  and c.embedded_at is null)) > 0
              or e.updated_at > coalesce(max(c.embedded_at), '-infinity'::timestamptz)
           then 'indexing'
         else 'indexed'
       end as state
  from kb.general_entries e
  left join kb.general_chunks c on c.entry_id = e.id
 group by e.id;

-- The dashboard's role reads the DERIVED state — and nothing else new anywhere. Schema
-- USAGE was granted by 023.
grant select on kb.entry_index_state to switchboard_approval;

-- 🚨 NOTHING GRANTS `switchboard_agent` ANYTHING. Named only to be denied, in
-- 014/016/019/020/021/022/023's idiom — a no-op today, stated so the intent is legible
-- in the migration a reviewer reads and not only in a test.
revoke all on kb.entry_index_state from switchboard_agent;
