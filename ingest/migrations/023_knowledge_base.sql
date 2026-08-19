-- 023: the knowledge base's first slice — the broker's AUTHORED business knowledge
-- (plan C6), as a pgvector-backed store the later retrieval layer reads.
--
-- WHY A NEW FILE. 014-022 are applied and checksum-enforced (src/migrate.ts): editing an
-- applied file makes `runMigrations` refuse. Everything here is new.
--
-- IMPLICITLY TRANSACTIONAL, in 015/016/019/020/021/022's idiom: `migrate.ts` submits this
-- file as ONE `client.query(sql)` and it contains no BEGIN/COMMIT — the create-then-grant
-- blocks below leave no window in which a table exists without its role surface.
--
-- WHAT THIS IS. Her general business knowledge — listings, business facts, policies,
-- FAQs, services — authored by HER through the authenticated dashboard (approval role,
-- 019's login machinery), chunked and embedded LOCALLY by the CRM daemon, and later
-- retrieved to answer questions. ONE scope only: general authored knowledge. The
-- client-DOCUMENT table (uploads, contracts) is deliberately NOT here — it is a separate,
-- separately-reviewed piece with its own ingestion and injection-defense posture
-- (plan C1/C6); creating its schema now would imply that review happened.
--
-- 🚨 THE FIRST `create extension` IN THIS LEDGER, deliberately. Migration 015 rejected
-- citext with "no migration in this repo issues `create extension`, and A2 is not the
-- place to start" — a statement about citext's cost/benefit, not a standing prohibition.
-- C6's settled decision (plan rev 3, research-ratified) is pgvector inside the client's
-- existing Postgres, and an extension is the only form pgvector takes. The guard below
-- makes the failure mode LOUD: on an image without pgvector the migration dies naming the
-- fix, never silently skipping — a knowledge base that silently has no vector type would
-- fail later and further from the cause.
--
-- 🚨 DIMENSION 1024, PINNED — and the RECORDED REASON IS CORRECTED HERE. The plan text
-- says "pgvector's `vector` type caps at 2,000 dimensions". That is wrong per pgvector's
-- own README: the `vector` TYPE supports up to 16,000 dimensions; it is the HNSW/IVFFlat
-- INDEX that caps at 2,000. The 1024 choice stands (the chosen local model emits 1024 and
-- must clear the INDEX cap, which it does); only the recorded reason changes. The column
-- is `vector(1024)`, not bare `vector`, so the SERVER rejects any other arity — the
-- mechanical enforcement `crm/test/migration-023.test.ts` pins.
--
-- FAIL-CLOSED EMBEDDING. `embedding` is NULLABLE and NULL means NOT YET RETRIEVABLE: a
-- chunk exists the moment the text is chunked, and becomes searchable only when the local
-- embedder has written its vector. The retrieval query's `embedding is not null` filter
-- (crm/src/kb/store.ts) is the other half of this contract; a chunk must never be ranked
-- by a vector it does not have.

do $$
begin
  begin
    create extension if not exists vector;
  exception when others then
    raise exception using
      message = 'migration 023: the pgvector extension ("vector") is not available in '
                'this PostgreSQL installation (create extension failed: ' || sqlerrm || '). '
                'The knowledge base requires it. Fix: run a pgvector-bearing image — '
                'docker-compose.yml pins pgvector/pgvector:0.8.6-pg16 — then recreate the '
                'container (docker compose up -d postgres) and re-run the migration.';
  end;
end $$;

create schema if not exists kb;

-- ---------------------------------------------------------------------------------------
-- ENTRIES — what she wrote, one row per authored unit of knowledge.
-- ---------------------------------------------------------------------------------------
--
-- `created_by` REFERENCES `approval.users` — the approver list 015 created and 019's
-- login machinery authenticates. The dashboard she authors through resolves its session
-- to exactly that table, so it is the right home for authorship; a text/uuid column
-- without the FK would make an entry authored by nobody representable, the defect class
-- 015's decisions schema forbids in terms.
--
-- NO DELETE for any role, and no hard-delete path: entries RETIRE (`status`,
-- `retired_at`) and stay, because a retrieval answer she saw last week must remain
-- explainable this week.
create table if not exists kb.general_entries (
  id         uuid        primary key default gen_random_uuid(),
  tenant_id  uuid        not null,
  kind       text        not null check (kind in ('listing','business_fact','policy','faq','service')),
  title      text        not null check (length(btrim(title)) > 0),
  body       text        not null check (length(btrim(body)) > 0),
  status     text        not null default 'active' check (status in ('active','retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  retired_at timestamptz,
  created_by uuid        not null references approval.users(id)
);

-- The embed daemon's work queue is "entries whose chunks are stale or missing", and the
-- dashboard lists by tenant + status; both walk this index.
create index if not exists general_entries_tenant_status
  on kb.general_entries (tenant_id, status);

-- ---------------------------------------------------------------------------------------
-- CHUNKS — the embeddable units of one entry, in order.
-- ---------------------------------------------------------------------------------------
--
-- `content_hash` is sha256 of `text`, written at insert by the same writer: the
-- re-embed decision ("did the text under this vector change?") and A4's verdict caching
-- both key on content, never on row identity.
create table if not exists kb.general_chunks (
  id           uuid         primary key default gen_random_uuid(),
  entry_id     uuid         not null references kb.general_entries(id),
  ordinal      int          not null,
  text         text         not null,
  embedding    vector(1024),           -- NULL = not yet embedded = NOT retrievable
  embedded_at  timestamptz,
  content_hash text         not null,
  unique (entry_id, ordinal)
);

-- HNSW over cosine distance — C6's settled index choice. 1024 is comfortably under the
-- INDEX's 2,000-dimension cap (the real location of the limit; see header).
create index if not exists general_chunks_embedding_hnsw
  on kb.general_chunks using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------------------
-- GRANTS. Written down table by table, in 014/015/019's precedent, so every pin is
-- against a grant the design chose rather than one an implementer happened to write.
-- NO ROLE HOLDS DELETE ON ANYTHING IN `kb` — the 42501 is the guarantee.
-- ---------------------------------------------------------------------------------------

-- The dashboard's role: she authors and edits entries there. Column-level UPDATE, so the
-- surface that edits knowledge cannot rewrite attribution (`created_by`) or forge
-- creation time — written once, at insert, like 015's decisions. (Per 015's note: a
-- nontrivial UPDATE also requires SELECT, granted alongside.) NOTHING on chunks: the
-- dashboard writes what she said; deriving embeddable units from it is the daemon's job,
-- and a compromised dashboard session should not be able to touch a vector.
grant usage on schema kb to switchboard_approval;
grant select, insert on kb.general_entries to switchboard_approval;
grant update (title, body, kind, status, updated_at, retired_at)
  on kb.general_entries to switchboard_approval;

-- The CRM daemon's role: reads entries (to chunk them), inserts chunks, and writes
-- EXACTLY the two embedding columns. It cannot touch `text`/`content_hash` after insert —
-- an embedder that could rewrite the text it embeds could silently decouple hash, text
-- and vector — and it cannot write entries at all: the daemon derives, never authors.
grant usage on schema kb to switchboard_crm;
grant select on kb.general_entries to switchboard_crm;
grant select, insert on kb.general_chunks to switchboard_crm;
grant update (embedding, embedded_at) on kb.general_chunks to switchboard_crm;

-- 🚨 NOTHING GRANTS `switchboard_agent` ANYTHING. Named only to be denied, in
-- 014/016/019/020/021/022's idiom — a no-op today, stated so the intent is legible in
-- the migration a reviewer reads and not only in a test.
revoke all on schema kb from switchboard_agent;
revoke all on kb.general_entries from switchboard_agent;
revoke all on kb.general_chunks  from switchboard_agent;
