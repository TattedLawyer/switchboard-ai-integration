-- 015: the approval lifecycle (Phase 3 / A2).
--
-- WHY THIS IS A NEW FILE AND NOT AN EDIT TO 014. Migrations are checksum-enforced
-- (src/migrate.ts:105-118): editing an applied file makes `runMigrations` refuse, because
-- at that point the database and the repository disagree about what schema exists. Every
-- change A2 makes to 014's objects therefore lands here, as ALTERs.
--
-- THIS FILE IS IMPLICITLY TRANSACTIONAL. `migrate.ts:122` submits it as ONE
-- `client.query(sql)` — a multi-statement simple query, which PostgreSQL wraps in an
-- implicit transaction provided the file contains no explicit BEGIN/COMMIT. It contains
-- none, and must never contain any: several statements below are only safe because the
-- statement before them cannot land without them (the drop-then-create of the index, and
-- the create-then-revoke of the trigger function).
--
-- WHAT A2 IS. Everything an agent proposes requires approval by an identified human. There
-- is no bypass tier, no veto window and no standing approval; the undo/hold-then-send
-- window was REJECTED by the owner on 2026-08-08 and must not return
-- (`.superpowers/sdd/a2-approval-queue-plan.md` §1a, §7.1). So this migration builds no
-- gate and no classifier: a classifier with one branch is not a classifier, it is a
-- constant, and a constant returning 'approval' is the absence of a gate expressed as code
-- — a ready-made re-entry point for the rejected design.

-- ---------------------------------------------------------------------------------------
-- PART 1 — the proposal's lifecycle columns.
-- ---------------------------------------------------------------------------------------

-- `payload_hash` HAS EXACTLY ONE JOB: idempotency-collision detection at the door, telling
-- a retry of the same call apart from a different proposal reusing a key (which today is a
-- live defect — `server.ts` returns 200 with the ORIGINAL row's id and the second payload
-- is silently discarded). It is NOT a TOCTOU control, NOT a display binding, and NOT what
-- makes the payload immutable; that is the column grant and the trigger in part 2.
--
-- THREE STEPS, NOT ONE, and the same for `expires_at` below. `add column ... not null`
-- without a default FAILS on a non-empty table, and A2 cannot verify whether this table
-- holds rows in any real deployment. This file is atomic, so the one-step form would abort
-- the whole migration and the fix would be a second migration written under pressure.
alter table approval.proposals add column payload_hash text;
-- A row that predates A2 was never hashed, and we will not manufacture a hash for bytes
-- whose custody we cannot attest. It gets a marker that is deliberately NOT valid hex, so
-- it can never collide with a real digest, and a constraint below forbids its approval.
update approval.proposals set payload_hash = 'legacy:unhashable' where payload_hash is null;
alter table approval.proposals alter column payload_hash set not null;

-- EXPIRY, on `pending` AND on `approved`. OWASP puts expiry in the APPROVAL RECORD, not
-- merely on the request: an approval carries its own validity window and execution after
-- it refuses. The 72 hours is JUDGMENT with NO SOURCE — no published work gives a number
-- for this — and it is surfaced as owner decision R5 rather than buried here. A5 owns TTL
-- values and may revise it; A2 must not pretend it derived it.
--
-- KNOWN COST, stated where the number lives: an approved row that is not executed inside
-- the TTL becomes `expired`, which is terminal, and A2 ships no re-proposal path (that is
-- A5's). That is a destroyed human decision. It is harmless today because nobody can
-- approve until A0b ships login, and it becomes unsafe the day A0b lands without A5.
alter table approval.proposals add column expires_at timestamptz;
-- A legacy row gets `created_at + TTL`, which for anything older than the TTL is already
-- in the past — so it is correctly ALREADY EXPIRED rather than granted a fresh window it
-- never had.
update approval.proposals
   set expires_at = created_at + interval '72 hours'
 where expires_at is null;
alter table approval.proposals alter column expires_at set not null;

-- AMENDMENT (§3.10) is not a decision on a proposal: it inserts a NEW proposal and moves
-- the original to `superseded`. Two rows, two acts, and no path from an amendment straight
-- to `approved` — PSD2's rule, that a changed payload invalidates the authentication.
-- `supersedes` is also how render-time duplicate collapse disposes of the rows it did not
-- surface (§3.9), reusing this machinery rather than inventing a disposition.
alter table approval.proposals add column supersedes uuid references approval.proposals(id);

-- WHO WROTE THE ASK. An amendment may be authored by the human, and "the agent proposed X"
-- stops being substantiable if the two are not distinguishable — which is the reason the
-- audit log exists at all (`docs/adr/agent-writer-boundary.md:283`). The default is
-- 'agent' so the column can be added NOT NULL against a non-empty table in one step, and
-- because every row that predates A2 came from the agent.
alter table approval.proposals add column authored_by text not null default 'agent';
alter table approval.proposals
  add constraint proposals_authored_by_check check (authored_by in ('agent', 'human'));
-- The FK to `approval.users` and the null-unless-human CHECK are added in PART 2, because
-- the table they reference does not exist yet.
alter table approval.proposals add column authored_by_user_id uuid;

-- The moment of the transition. Distinct from `approval.decisions.decided_at`: this one is
-- on the row that moved, and it is one of exactly two columns the approval role may UPDATE.
alter table approval.proposals add column decided_at timestamptz;

-- THE STATE SET — eight, from 014's three (§3.4). `held` and `cancelled` are absent
-- because they existed only to serve the rejected undo window. `dismissed` is absent
-- because it is a DECISION WITHOUT A TRANSITION: an explicit "Not now" writes a decision
-- row and leaves the proposal pending, which is why it lives in `approval.decisions.kind`
-- and not here.
--
-- THE DROP IS LOAD-BEARING AND MUST COME FIRST. 014's constraint is auto-named
-- `proposals_state_check` (an inline column CHECK). Adding a second CHECK without dropping
-- it yields the CONJUNCTION of the two, so the five new states remain unusable and the
-- migration reports success — verified on PG 16.14. There is no `if exists`: if 014's
-- constraint is not there under that name, this deployment is not the one this file was
-- written against, and stopping is the correct outcome.
alter table approval.proposals drop constraint proposals_state_check;
alter table approval.proposals
  add constraint proposals_state_check
  check (state in ('pending', 'approved', 'rejected', 'expired', 'superseded',
                   'executing', 'executed', 'execution_failed'));

-- A legacy row may sit pending, be rejected, or age out — but it may never be APPROVED.
-- An approval is an attestation about a specific payload, and we cannot attest bytes we
-- never hashed. Forbidding the one outcome rather than the row keeps it disposable.
alter table approval.proposals
  add constraint proposals_legacy_never_approved
  check (payload_hash <> 'legacy:unhashable' or state <> 'approved');

-- THE INDEX — a DISTINCT name, an explicit DROP, and no `if not exists`.
--
-- 014 created `proposals_pending_by_tenant` on `(tenant_id) where state = 'pending'`.
-- Reissuing that NAME with a different column list under `if not exists` is a documented
-- silent no-op: CREATE INDEX's own page says "there is no guarantee that the existing index
-- is anything like the one that would have been created", because the check is on the
-- relation name only — not columns, expression, method, predicate or uniqueness. Measured
-- on PG 16: NOTICE ... skipping, CREATE INDEX reported as success, `expires_at` never
-- added, and the pin that asserted "the index demonstrably created" was satisfied by 014's
-- index. So:
--   · a DISTINCT name, so a future collision cannot silently no-op;
--   · no `if not exists`, so a name collision is an ERROR at deploy rather than a skip;
--   · an explicit DROP of the old one, because leaving both means the cap count may still
--     choose the one-column plan and the new index's presence would prove nothing about
--     what actually runs.
-- The drop and the create are atomic together only because this file has no explicit
-- BEGIN/COMMIT (see the header).
drop index if exists approval.proposals_pending_by_tenant;
-- The predicate is CONSTANT. `where state = 'pending' and expires_at > now()` is NOT
-- creatable — "functions in index predicate must be marked IMMUTABLE" — verified by two
-- independent reviewers on ephemeral databases and pinned in
-- `ingest/test/migration-015-proposals.test.ts`. The expiry filtering happens in the
-- query; the index carries `expires_at` as a column so the validity-filtered cap count
-- has something to range over.
create index proposals_pending_by_tenant_expiry
  on approval.proposals (tenant_id, expires_at)
  where state = 'pending';
