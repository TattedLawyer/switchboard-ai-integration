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

-- ---------------------------------------------------------------------------------------
-- PART 2 — the tables an approval needs, the grants, and the trigger.
-- ---------------------------------------------------------------------------------------

-- THE APPROVER LIST. A STRICT SUBSET, and the strictness is the point: `id`, `email`,
-- `created_at`, `disabled_at`, and NOTHING ELSE. No role column, no permissions column, no
-- password, no tenant column — `docs/adr/approver-identity.md:140-144` makes any of those a
-- STOP-and-report, and this shape leaves A0b's work purely ADDITIVE. A0b owns login,
-- session, resolving an email to a user, and extending this table.
--
-- WHY A2 CREATES IT AT ALL rather than waiting for A0b: so `approver_user_id` is a real
-- foreign key from the FIRST migration that records a decision. The alternative — a
-- nullable approver, or a text approver "temporarily" — makes an unattributed approval
-- REPRESENTABLE, which `approver-identity.md:149-150` forbids in terms and which would
-- weaken §3.11's claim to buy a schedule.
create table approval.users (
  id          uuid primary key default gen_random_uuid(),
  email       text        not null,
  created_at  timestamptz not null default now(),
  disabled_at timestamptz
);

-- `citext` is REJECTED: no migration in this repo issues `create extension`, and A2 is not
-- the place to start. So: `text` plus a unique index on `lower(email)`.
--
-- 🚨 THIS INDEX IS STORAGE HYGIENE ONLY AND MUST NEVER BECOME A COMPARISON PREDICATE.
-- `lower()` is NOT identity-preserving for mailboxes — U+212A KELVIN SIGN lower-cases to
-- `k`, U+0130 collides with `i`, both measured on PG 16.14 — and RFC 5321 §2.3.11 makes
-- the local part case-sensitive and the mailbox owner's business. A2 performs NO email
-- comparison anywhere; resolving an address to a user is A0b's concern, and A0b inherits
-- this warning. Promoting this index into a security predicate would reintroduce the
-- homoglyph defect that a whole rejected design was built on.
create unique index users_email_lower_unique on approval.users (lower(email));

-- THE DECISION. Multi-row per proposal BY DESIGN: `dismissed` rows accumulate, because an
-- explicit "Not now" is a decision that does not move the proposal (§3.7).
create table approval.decisions (
  id               uuid primary key default gen_random_uuid(),
  proposal_id      uuid not null references approval.proposals(id),
  -- `dismissed` is the third outcome and it has no state transition. MCP's accept/decline/
  -- cancel is right in spirit, but `cancel` is a MODAL-DISMISSAL event and a web page has
  -- no modal: we cannot distinguish "considered it and walked away" from "closed the
  -- laptop", and recording the second as the first manufactures evidence about a human's
  -- state of mind. Passive navigation records nothing at all.
  kind             text not null check (kind in ('approved', 'rejected', 'dismissed')),
  -- NEVER a string. An approval whose approver is free text is an unattributed approval
  -- wearing a name (`approver-identity.md:149-150`).
  approver_user_id uuid not null references approval.users(id),
  reason           text,
  -- AUDIT METADATA ONLY. 🚨 `renderer_version` IS NEVER READ IN THE REQUEST PATH and must
  -- never become a predicate. The runtime check that once compared it was deleted: it had
  -- no nameable threat (the payload is immutable and the approval is attributable
  -- regardless of what rendered it) and a concrete cost (after any renderer deploy, every
  -- approved-but-unexecuted proposal would refuse execution permanently, destroying a real
  -- human approval with no recovery path in this workstream). An unused column with an
  -- obvious comparison available is a re-entry point; this comment is the guard on it.
  renderer_version text not null,
  -- THE SAME-TRANSACTION DISCRIMINATOR. Not `xmin`: `xmin` is a 32-bit `xid` and wraps,
  -- while `txid_current()` is a 64-bit epoch'd `bigint`, so comparing them is correct only
  -- within one epoch and SILENTLY WRONG afterwards — a failure that appears only on a
  -- long-lived database and looks like nothing. `pg_current_xact_id()` returns `xid8` and
  -- is epoch-safe, on both the default here and the comparison in the trigger.
  xact_id          xid8 not null default pg_current_xact_id(),
  -- Distinct from the proposal's `created_at`; the delta between them IS the staleness
  -- evidence an auditor wants.
  decided_at       timestamptz not null default now(),
  -- A rejection with no reason is not a decision anyone can review later. Enforced by the
  -- database rather than by the form, because the form is not the thing that has to be
  -- true. Whitespace is not a reason.
  constraint decisions_rejection_needs_reason
    check (kind <> 'rejected' or (reason is not null and btrim(reason) <> ''))
);

-- THE TRIGGER READS THIS INDEX ON EVERY APPROVE AND EVERY REJECT. Postgres creates no
-- index for a foreign key, so without it the lookup is a sequential scan over an
-- append-only table that only grows. Nothing breaks and no test reds without it — the cost
-- is invisible until it is a migration on a live table rather than a line in this file.
-- Free now, not free later. (rev-8 review, Minor M-1.)
create index decisions_by_proposal_kind on approval.decisions (proposal_id, kind);

-- THE EXECUTION LOG. Append-only. A `started` row with no terminal sibling IS the
-- crash-mid-send state, and `at` on that row is what makes it queryable BY AGE.
--
-- 🚨 A2 BUILDS NO AUTO-REAPER, DELIBERATELY. A timer that flips a live in-flight send to
-- `failed` is worse than a stuck row. So `executing` is a permanently non-terminal row
-- class with no timer-drivable exit, A2 makes it DETECTABLE, and A5 owns the reaper
-- contract — deciding, with knowledge of the vendor's delivery semantics, when a `started`
-- row may be adjudicated. Not a cap wedge: `executing` rows sit outside the pending count.
create table approval.executions (
  id               uuid primary key default gen_random_uuid(),
  proposal_id      uuid not null references approval.proposals(id),
  kind             text not null check (kind in ('started', 'succeeded', 'failed')),
  -- Propagated to the vendor. Whether the C5 provider HONOURS it is a C5 acceptance
  -- criterion, never an A2 assumption.
  idempotency_key  text not null,
  vendor_reference text,
  error            text,
  at               timestamptz not null default now()
);

-- The amendment author's FK, deferred from part 1 because `approval.users` did not exist
-- yet. CHECK-enforced BOTH ways: a human-authored amendment MUST name its author, and an
-- agent-authored proposal must NOT carry one.
alter table approval.proposals
  add constraint proposals_authored_by_user_fk
  foreign key (authored_by_user_id) references approval.users(id);
alter table approval.proposals
  add constraint proposals_human_author_attributed
  check ((authored_by = 'human') = (authored_by_user_id is not null));

-- ---------------------------------------------------------------------------------------
-- THE TRIGGER. An invariant belongs in the database; a workflow does not.
--
-- That line is JUDGMENT — no source draws it, and the repo must say so rather than imply
-- an authority it does not have. What follows is ~30 lines of ASSERTION: frozen columns,
-- the legal transition set, and the decision-row requirement. The transition WORKFLOW
-- stays in TypeScript.
--
-- NO `SECURITY DEFINER`, deliberately. It would buy enforcement only for callers who
-- consented to use it, while importing PUBLIC-EXECUTE-by-default and the `search_path`
-- misuse surface. (And note for whoever is tempted later: CVE-2018-1058 is a CLIENT-
-- APPLICATION CVE and the project's guide for it contains no `SECURITY DEFINER` advice —
-- the hazard here is ordinary documented guidance, not a CVE. If one is ever created, the
-- full recipe is mandatory: `SET search_path = <schema>, pg_temp` with pg_temp LAST,
-- `REVOKE ALL ... FROM PUBLIC`, then a selective `GRANT EXECUTE`.)
--
-- Being invoker-rights has one consequence that is load-bearing and invisible: the lookup
-- below runs with the CALLER's privileges, so `SELECT` on `approval.decisions` is a HARD
-- RUNTIME PREREQUISITE of both human-driven transitions. The grant block gives it. A
-- future least-privilege narrowing to `insert` only would break EVERY approval with
-- `permission denied for table decisions` — an error naming the wrong table.
-- ---------------------------------------------------------------------------------------
create function approval.proposals_guard() returns trigger
language plpgsql
as $guard$
begin
  -- (a) FROZEN COLUMNS. What the human approved cannot change afterwards, on any path,
  -- including paths nobody has written yet. This is the guarantee A2 actually makes about
  -- her data — not anything about what her browser painted.
  if new.payload         is distinct from old.payload
  or new.payload_hash    is distinct from old.payload_hash
  or new.rationale       is distinct from old.rationale
  or new.idempotency_key is distinct from old.idempotency_key
  or new.action_type     is distinct from old.action_type
  or new.created_at      is distinct from old.created_at
  or new.supersedes      is distinct from old.supersedes
  or new.authored_by     is distinct from old.authored_by
  then
    raise exception 'frozen column is immutable'
      using detail = 'payload, payload_hash, rationale, idempotency_key, action_type, '
                     'created_at, supersedes and authored_by never change after insert';
  end if;

  if new.state is distinct from old.state then
    -- (b) THE LEGAL TRANSITION SET (§3.4). Terminal means terminal: a re-proposal is a NEW
    -- ROW, never a resurrection. `approved -> pending` is absent because an approval that
    -- can be un-made is not evidence, and `executing -> approved` is absent because that
    -- is the retry loop that double-sends.
    if not (
         (old.state = 'pending'   and new.state in ('approved', 'rejected', 'expired', 'superseded'))
      or (old.state = 'approved'  and new.state in ('expired', 'executing'))
      or (old.state = 'executing' and new.state in ('executed', 'execution_failed'))
    ) then
      raise exception 'illegal proposal transition: % -> %', old.state, new.state;
    end if;

    -- (c) A HUMAN DISPOSITION WITH NO ATTRIBUTABLE HUMAN IS NOT REPRESENTABLE.
    --
    -- The predicate covers `approved` AND `rejected`, not `approved` alone. Scoped to
    -- `approved`, a bare `update ... set state = 'rejected' where state = 'pending'` was
    -- MEASURED to succeed: UPDATE 6, zero decision rows, no error. A rejection is a human
    -- decision, and if the database does not require the human then the word is not
    -- evidence of one.
    --
    -- MACHINE-DRIVEN TERMINAL TRANSITIONS ARE DELIBERATELY EXEMPT, and that distinction is
    -- the whole content of the rule: `pending -> expired` (the sweeper) and
    -- `pending -> superseded` (amendment, and render-time duplicate collapse) carry no
    -- decision row BECAUSE NOBODY DECIDED. This is also why the emergency manual drain
    -- targets `expired` and not `rejected` — an operator draining a wedged queue is not
    -- deciding anything, and recording their bulk action as `rejected` would be a
    -- fabricated decision.
    --
    -- MATCHING KIND, and SAME TRANSACTION. Matching kind, because `approval.decisions` is
    -- append-only and multi-row: without it a prior `dismissed` row satisfies the check
    -- for `approved`. Same transaction, because without it a decision row committed at any
    -- point in the past satisfies it forever.
    if new.state in ('approved', 'rejected') then
      if not exists (
        select 1 from approval.decisions d
         where d.proposal_id = new.id
           and d.kind        = new.state
           and d.xact_id     = pg_current_xact_id()
      ) then
        raise exception 'a % transition requires an approval.decisions row of kind %, naming an approver, written in the SAME transaction', new.state, new.state;
      end if;
    end if;
  end if;

  return new;
end
$guard$;

-- 🚨 THE ENTIRE CONTROL, AND THERE IS NO BELT. Two revisions of this design credited a
-- schema-wide belt and both were measured inert on PG 16: `REVOKE ... ON ALL FUNCTIONS IN
-- SCHEMA` is a ONE-SHOT LOOP over existing objects, and `ALTER DEFAULT PRIVILEGES ...
-- REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` stores NO `pg_default_acl` row at all, so a
-- later function keeps `proacl` NULL and an unprivileged role executes it fine. That line
-- was attempted, measured ineffective, and MUST NOT BE RE-ADDED.
--
-- ORDERING IS THE FIX. The revoke comes immediately AFTER the create, in the same
-- implicit transaction, so there is no window. Revoking PUBLIC EXECUTE on a trigger
-- function does not stop the trigger firing — verified.
--
-- 015 CREATES EXACTLY ONE FUNCTION, and its name is counted and asserted, so the pin's
-- subject set is KNOWN rather than assumed empty. Any later migration that adds a function
-- to this schema must revoke it in the same file: nothing automatic protects it.
revoke execute on function approval.proposals_guard() from public;

create trigger proposals_guard
  before update on approval.proposals
  for each row execute function approval.proposals_guard();

-- ---------------------------------------------------------------------------------------
-- GRANTS. Written down table by table, in 014's precedent, so every pin below is against a
-- grant the design chose rather than one an implementer happened to write.
-- ---------------------------------------------------------------------------------------

-- COLUMN-LEVEL, NEVER TABLE-LEVEL. Two subtleties, both documented and both load-bearing:
--   · "any nontrivial UPDATE will require SELECT privilege as well", so this grant is
--     necessarily larger than `UPDATE (state)` alone — 014 already granted SELECT;
--   · "the table-level grant is unaffected by a column-level operation" — so if TABLE-level
--     UPDATE is ever granted here, later column-level REVOKEs do nothing. That is a
--     migration-ordering hazard, not a theoretical one, and it is why this is the only
--     UPDATE grant in the file.
grant update (state, decided_at) on approval.proposals to switchboard_approval;

-- Append-only, both of them. The `42501` on UPDATE/DELETE is the guarantee, and it is
-- pinned against these lines rather than against whatever an implementer chose.
grant select, insert on approval.decisions  to switchboard_approval;
grant select, insert on approval.executions to switchboard_approval;

-- SELECT ONLY. The role that RECORDS approvals must not be able to MINT approvers. It can
-- already forge an approval naming a real user — the database authenticates nobody, and
-- KNOWN-ISSUES discloses that — so this is not categorical; what it buys is that the set
-- of people who can approve is not writable by the thing that records approvals. The first
-- row is created by an operator through `ingest/src/cli/approval-user-add.ts`, connecting
-- as the migration owner.
grant select on approval.users to switchboard_approval;

-- No DELETE anywhere. No grant option anywhere. And nothing — not one privilege, on any of
-- these objects — to `switchboard_agent`, which is named here only to be denied, in 014's
-- idiom, so the intent is legible in the migration a reviewer reads and not only in a test.
revoke all on approval.users      from switchboard_agent;
revoke all on approval.decisions  from switchboard_agent;
revoke all on approval.executions from switchboard_agent;
