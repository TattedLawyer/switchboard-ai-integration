# ADR: the writer boundary — the host writes, the agent only proposes

**Status:** accepted, **AMENDED 2026-08-07 by A1** — see "Amendment" below. The decision (the host
writes; the agent's only output is a validated object) is unchanged; **which process is "the host"**
changed, and the two-pool consequence this ADR originally derived is **withdrawn**.
**Applies to:** A1 (action/intent objects), A2 (approval queue), A3 (agent-decision audit log),
and every later task that needs a row written as a consequence of something the agent decided
**Plan:** `docs/superpowers/plans/2026-08-07-phase3-agent-layer.md` (Track A, A0a; global constraint #2)
**Review that raised it:** `.superpowers/sdd/phase3-plan-review.md` (Blocker B-1)

## Problem

Phase 3's spine needs INSERTs. A proposal is a row. An approval decision is a row. Every audit
entry is a row. Global constraint #1 — nothing acts without an identified approver — is only
meaningful if those rows exist.

The agent cannot write any of them, and that is deliberate. It is also, unusually for a claim of
this kind, mechanically true today rather than aspirational:

- `ingest/migrations/005_agent_role.sql` creates the `switchboard_agent` login role and grants it
  nothing. The migration says so in its own header: "The role deliberately gets no grant on
  raw/ingest at all."
- `ingest/src/migrate.ts:190-191` grants exactly `usage` on the analytics schema and `select` on
  its tables; `ingest/src/migrate.ts:213` / `:239` extend only `select` to relations dbt creates
  later, via `alter default privileges`. There is no `insert`, `update`, `delete`, or `create`
  anywhere in `grantAgentReadOnly` (`ingest/src/migrate.ts:180-240`).
- `agent/test/db-privileges.test.ts` proves it by running real statements through the role's own
  pool: INSERT (`:54-58`), UPDATE and DELETE (`:60-67`), cross-schema SELECT against `raw` and
  `ingest` (`:69-76`), and CREATE TABLE in both the analytics schema and `public` (`:78-85`) each
  assert Postgres error `42501`. The suite's one positive case (`:49-52`) asserts the role can
  still read the mart — the capability it exists for.
- The ACL string itself is pinned in two places: `ingest/test/grant-role-scope.test.ts:73` and
  `ingest/test/raw-body-expand.test.ts:320`, both asserting the default-privilege entry contains
  `switchboard_agent=r`.

So constraint #2 ("`switchboard_agent`'s ACL does not change") and Track A ("we need INSERTs") are
in direct contradiction until this ADR names a writer that is not the agent.

## Decision

**The host process writes. The agent's only output is a validated object handed back across the
MCP boundary.**

Concretely:

1. The agent produces a proposal as *data* — a typed, validated value describing what it wants
   done, to whom, with what payload, derived from which records, with an idempotency key (A1).
   It returns that value through the MCP tool boundary. It does not persist it and has no
   privilege that would let it.
2. The writing process — trusted application code, not model output — validates the object against
   the schema, then performs the INSERT. **AMENDED:** that process is the client-facing approval
   service, and its connection is **not** the full-privilege application one. It authenticates as
   `switchboard_approval` (migration 014), which holds `select, insert` on the proposals table and
   nothing else. The original wording named `DATABASE_URL`/role `switchboard`; see the Amendment
   for why the migration owner is the wrong role for this job.
3. Approval decisions and audit rows are written by the same host code path, never by anything
   reachable from a model.

`switchboard_agent`'s grant set is untouched. Every assertion listed above continues to pass
unmodified.

### One correction to the plan's wording, verified in code

The plan describes the host as "already the full-privilege app role." **That is not true of the
agent host as it exists today.** `agent/src/host/run-report.ts:8` builds its only pool from
`agentConnectionString()` (`agent/src/host/agent-db.ts`), which resolves to the read-only
`switchboard_agent`. The agent host currently holds *no* writable connection at all. The
full-privilege role lives on the ingest side.

## 🔄 Amendment (A1, 2026-08-07): the writer is the approval service, not the agent host

**What this ADR originally derived from the correction above — "implementing A1 means introducing a
second, separate pool in the host" — is WITHDRAWN. Do not add a writable pool to `agent/src/`.**

Two research passes and an adversarial review established the reason, and it is not a preference:

1. **The property is one env var away and adding a pool destroys it permanently.** "The agent
   process holds no write-capable credential" was, at the time of the original decision, neither
   held nor enforced — `agent-db.ts` derived the agent credential from `DATABASE_URL`, `ci.yml`
   set `DATABASE_URL` job-wide, and nothing in the repo ever set `AGENT_DATABASE_URL`. So the
   property was *available* rather than *held*. An in-process writer pool would not merely fail to
   hold it; it would put it permanently out of reach of any future configuration. A1 instead
   bought it: `agentConnectionString()` now fails closed, and `agent/src/` contains zero references
   to `DATABASE_URL`.
2. **The marginal cost of a process boundary is zero processes.** The original reasoning priced a
   separate writer as "a second deployable per client." It is not: plan item A0b already commits
   Phase 3 to a client-facing authenticated approval surface — login, session, approval page, audit
   row — and every one of those is a write. The writer lives in a process the plan already
   committed to building.
3. **Authority shape, not authority location.** The question "what is the real difference between a
   writable pool and a credential to a door that writes on your behalf" has a precise answer: **the
   door's grammar.** A pool speaks SQL — rewrite `analytics.customer_360`, forge an approval, forge
   an audit row, or `grant insert … to switchboard_agent` and retire the differentiator itself. The
   door speaks one row shape. That difference is the entire claim.

**So: the writer lives in the client-facing approval service** (`approval/`, new in A1). The agent
host keeps exactly one pool, read-only, forever, and hands proposals across an authenticated door
(`agent/src/host/propose.ts` — no `pg` import, no SQL, swept by
`agent/test/writer-boundary.test.ts`).

### The approval service's own role

The service does **not** connect as `DATABASE_URL`'s role. That role is the migration owner, and
per PostgreSQL's own semantics ("Ordinarily, only the object's owner (or a superuser) can grant or
revoke privileges on an object") the owner is exactly who can run
`grant insert … to switchboard_agent`. A compromise there would not need to defeat the containment;
it could delete the differentiator. Migration 014 therefore creates **`switchboard_approval`**: a
non-owner login role with `usage` on one schema and `select, insert` on one table, no grant option,
no `UPDATE`, no `DELETE`, and no reach into `raw`, `ingest`, or the analytics schema. Pinned by
`ingest/test/approval-role-scope.test.ts` — including an assertion that its attempt to grant insert
to `switchboard_agent` leaves the ACL byte-identical. (Postgres answers that attempt with a WARNING
rather than an error, so the pin is on the catalog, not on an exception.)

The proposal table also lives **outside** the analytics schema on purpose: `grantAgentReadOnly()`
attaches `alter default privileges … grant select on tables to switchboard_agent` inside
`DBT_SCHEMA`, so a proposals table created there would have silently become agent-readable. Not a
breach of the write claim, but an unexamined widening of the read surface.

### What the claim may say — three tiers, and the boundaries between them are the point

- **Database-enforced, at runtime, in every deployment:** the agent's connection authenticates as
  `switchboard_agent`, a Postgres role holding `usage` and `select` and nothing else; INSERT,
  UPDATE, DELETE and CREATE are refused with SQLSTATE `42501`, proven by executing those statements
  against a live database (`agent/test/db-privileges.test.ts`).
- **Enforced at process start, in every deployment:** the agent host refuses to **start** without
  `AGENT_DATABASE_URL`, and refuses to start on any connection whose `current_user` is not
  `switchboard_agent` (`assertAgentRole`). "Start", deliberately, not "serve every call": the check
  runs once per entrypoint, before any work, against the single pool that entrypoint opens.
  `createMcpServer` receives a pool it did not open, so an assertion there would be a late check of
  someone else's decision; what makes the boot check sufficient is that no other pool may exist,
  which is the third tier's job.
- **Enforced in CI, about the code and not about your deployment:** no module under `agent/src/`
  constructs a second pool or reads a full-privilege credential, and a boot test runs the proposal
  path with no such credential present. This proves the agent *never needs* write authority; it
  does not, by itself, prove that a given operator withheld it — which is what the two tiers above
  are for.

### Residual risk, stated plainly

A compromised agent host holds the credential for the proposal door, so it can forge and flood
well-formed proposals — bounded by a unique idempotency key and a pending-proposal cap. It cannot
execute SQL, forge an approval, or forge an audit row, and every proposal is inert until an
identified human approves it. **And, conceded: on a single-box self-hosted deployment both
processes likely run as the same OS user, so the writer credential is readable from the other
process's configuration. This is credential locality, not OS sandboxing.** Recorded in
`KNOWN-ISSUES.md` (Part I) as an accepted disclosure, not only here.

## Rejected alternative: a third `switchboard_proposer` role with INSERT-only

The plan's option (b): create a narrow role holding `insert` on exactly one append-only table, no
`update`, no `delete`, and *extend* the existing ACL tests to assert the new role alongside rather
than relaxing them.

It is a legitimate design and it does satisfy constraint #2 literally. Rejected for three reasons:

1. **It buys nothing option (a) does not already have.** Under option (a) the agent has no write
   privilege whatsoever — the strictly stronger position. A proposer role moves the boundary from
   "the agent cannot write" to "the agent can write one shape of row," which is a weaker sentence
   to defend and a longer one to explain to a customer.
2. **The validation still has to happen in host code either way.** The proposal is model-derived
   data; something trusted must check it against the schema before it becomes a row. A dedicated
   Postgres role does not perform that check — column constraints are not schema validation of a
   payload. So option (b) adds a role and a migration without removing the trusted step that
   option (a) already requires.
3. **It widens the surface the differentiator rests on.** The comparables position is that the
   read-only property is enforced by the database, verified against the two most prominent
   Postgres MCP servers. "One role, `=r`, nothing else" survives an audit in a sentence. "Two
   roles, one of which can insert into one table under these conditions" needs a paragraph and an
   invitation to check whether the conditions hold.

Recorded for the future: if a deployment shape ever genuinely requires the agent process itself to
persist (it does not today, since the host and the agent are the same process), option (b) is the
correct next step and its shape is already worked out above — a new role, INSERT-only, one
append-only table, existing assertions extended rather than edited.

## 🚨 LANDMINE

**A failing `switchboard_agent=r` assertion is a design violation, not a stale test.**

The three suites that pin it — `agent/test/db-privileges.test.ts`,
`ingest/test/grant-role-scope.test.ts:73`, `ingest/test/raw-body-expand.test.ts:320` — will go red
the moment anyone runs `grant insert on <anything> to switchboard_agent`. That is the pin working,
not the pin rotting.

The predictable failure mode, named by the Gate 0b reviewer (`.superpowers/sdd/phase3-plan-review.md`
B-1): an implementer under time pressure hits the red tests, reads them as out of date, updates
the expected ACL string, and goes green. At that moment the repo's strongest verified
differentiator has been deleted to make a task pass, and nothing in the diff looks alarming.

The correct response to a red `=r` assertion is to **stop and re-read this ADR**, not to edit the
assertion. If a task appears to require the agent to write, the task is wrong.

## Consequences

- ~~A1's brief inherits the two-pool requirement and the containment rule above.~~ **Withdrawn by
  the amendment.** A1's brief inherits the opposite: `agent/src/` acquires no writable credential,
  and the sweep in `agent/test/writer-boundary.test.ts` reds if it ever does.
- The proposal object needs a schema and a validator in the writing process (the approval service); a malformed or
  out-of-allowlist proposal is a refusal with an audit row, never a coerced INSERT.
- The audit log (A3) is written entirely by host code, which is what makes "the agent decided X"
  an assertion the system can make about itself rather than one the agent makes about itself.
- Nothing in the identity or ingest layers changes. `docs/adr/identity-resolution.md`'s positioning
  note already anticipated this: "the approval table that arrives with Phase 3's gated write
  action" is Switchboard operational state, not a system of record.
