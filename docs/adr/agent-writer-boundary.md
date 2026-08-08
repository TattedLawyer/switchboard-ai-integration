# ADR: the writer boundary — the host writes, the agent only proposes

**Status:** accepted (Phase 3, plan item A0a) — decision recorded, not yet implemented
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
2. The host process — trusted application code, not model output — validates the object against
   the schema, then performs the INSERT using a **full-privilege application connection**, the
   same class of connection the ingest application already uses (`DATABASE_URL`, role
   `switchboard`).
3. Approval decisions and audit rows are written by the same host code path, never by anything
   reachable from a model.

`switchboard_agent`'s grant set is untouched. Every assertion listed above continues to pass
unmodified.

### One correction to the plan's wording, verified in code

The plan describes the host as "already the full-privilege app role." **That is not true of the
agent host as it exists today.** `agent/src/host/run-report.ts:8` builds its only pool from
`agentConnectionString()` (`agent/src/host/agent-db.ts:6-15`), which resolves to
`AGENT_DATABASE_URL` or rewrites `DATABASE_URL`'s credentials to `switchboard_agent`. The agent
host currently holds *no* writable connection at all. The full-privilege role lives on the ingest
side.

This does not change the decision, but it does add work the plan did not price: implementing A1
means introducing a **second, separate pool** in the host — a writer pool, distinct from the
read-only agent pool — and keeping the two from being confused at a call site. Two consequences
follow, and both belong in the A1 brief:

- The read pool used to serve tool calls must stay `switchboard_agent`. If a future refactor
  "simplifies" the host down to one pool, the database-enforced read-only property is lost
  silently, because every read would still work.
- The writer pool should be reachable only from the proposal/approval/audit modules, not from the
  MCP tool surface. *(Judgment, not a sourced requirement: this is the same containment move as
  `registerReadOnlyTool` (`agent/src/mcp/server.ts:16-26`), which makes the allowlist enforcement
  rather than convention by routing all registration through one guard that throws.)*

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

- A1's brief inherits the two-pool requirement and the containment rule above.
- The proposal object needs a schema and a validator on the host side; a malformed or
  out-of-allowlist proposal is a refusal with an audit row, never a coerced INSERT.
- The audit log (A3) is written entirely by host code, which is what makes "the agent decided X"
  an assertion the system can make about itself rather than one the agent makes about itself.
- Nothing in the identity or ingest layers changes. `docs/adr/identity-resolution.md`'s positioning
  note already anticipated this: "the approval table that arrives with Phase 3's gated write
  action" is Switchboard operational state, not a system of record.
