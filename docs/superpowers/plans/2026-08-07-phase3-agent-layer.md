# Phase 3 — the agent layer (plan, rev 3 — research-ratified)

> **For agentic workers:** REQUIRED SUB-SKILL — `superpowers:subagent-driven-development`. Every task: implementer → framed review → fix loop → cold unframed review before push. The gates in `[[switchboard-verification-gates]]` bind — notably **Gate 0** (the controller may not prescribe fixes), **Gate 0a** (research → plan presented to the owner → execute), **Gate 0b** (every plan gets a fresh-agent adversarial review before dispatch).

**Rev 3 supersedes rev 2.** Rev 1 → rev 2 absorbed the Gate 0b adversarial review (5 Blockers / 7 Important / 6 Minor, `.superpowers/sdd/phase3-plan-review.md`). Rev 2 → rev 3 absorbs two primary-source research passes — `.superpowers/sdd/p3-agent-architecture-research.md` and `.superpowers/sdd/p3-document-layer-research.md` — which **settled the framework question with vendor citations and found one security surface rev 2 did not list.** Where a claim is cited it is sourced; where it is judgment it is labelled.

**Goal:** Switchboard stops only *knowing* things accurately and starts *doing* things — answering questions from the reconciled record, assembling documents from the customer's own templates, and placing bounded outbound calls — with every outward action gated by an identified human approver and fully audited.

**Architecture:** one safety spine (action objects → approval queue → audit log → injection defense) carrying three capability tracks (console, documents, voice). The spine is built first; no capability ships before the constraint that makes it safe.

---

## Verified facts about the system as it exists today

Rev 1 guessed at these. The Gate 0b reviewer checked them in code; these are the corrected premises this plan is built on.

- **The agent genuinely cannot write.** `switchboard_agent` holds `usage` + `select` only; `agent/test/db-privileges.test.ts` drives real INSERT/UPDATE/DELETE through the role's own pool and asserts `42501`; `ingest/test/grant-role-scope.test.ts:73` pins the ACL string `switchboard_agent=r`. **Stronger than rev 1 claimed.**
- **The tool allowlist is enforcement, not convention** — `registerReadOnlyTool` throws on any name outside `READ_TOOLS`, which currently holds exactly one tool.
- **There is NO agent-decision audit log.** What exists is a hash-chained source ledger, a gap ledger, an ingest journal and quarantine — records of *data arriving*, not of *an agent deciding*. Rev 1's claim that our machinery "already provides most of what a framework offers" overstated by one whole table family.
- **`customer_360` exposes no date or period column.** One mart, one row per entity, one MCP tool taking one `entity_id`.
- **There is no user, no login, and no actor identity anywhere.** Operator CLIs authenticate nobody; `gap-ack` records an acknowledgement without a verified actor.
- **Honest-refusal vocabulary already exists** in `agent/src/host/report.ts` (`money()`, `flagsFor()`, `fenceUntrusted`) — new surfaces extend it rather than inventing a second dialect.

---

## Global constraints

1. **Nothing acts without approval** by an *identified* approver (see A0b). No "low-risk" bypass tier.
2. **`switchboard_agent`'s ACL does not change.** 🚨 **LANDMINE:** a test asserting `switchboard_agent=r` failing is a **design violation, not a stale test**. The obvious "fix" (granting the agent INSERT) deletes the repo's strongest verified differentiator. See A0a.
3. **Injection defense is a hard gate** — no capability that puts customer-controlled text into a model's context ships before A4 holds for that boundary. 🚨 **Research finding (rev 3): a customer-supplied TEMPLATE is a code-execution surface**, not merely untrusted text — the formatting-preserving templating library documents an `EXEC` command and depends on Node's `vm`. A4 must treat template ingestion as an execution boundary, not a text boundary.
4. **Do not invent a multi-tenant SaaS model.** One configured deployment tenant; a fix that appears to require multi-tenant machinery is STOP-and-report. *(Owner, 2026-08-03.)*
5. **Compliance is the customer's obligation; ours is switches plus evidence.** Per-tenant toggles defaulting conservative, plus an audit trail recording which settings were in force. No hardcoded jurisdiction policy. *(Owner, 2026-08-07.)*
6. **Honest refusal over confident guessing**, everywhere, reusing the existing vocabulary.
7. **Dependency trades are recorded in this plan, not discovered at implementation.** Pre-accepted: `hai-guardrails` (6 runtime deps + `@langchain/core` peer — production-proven in the owner's other product) · one telephony SDK · **`pgvector`** (extension in the client's existing Postgres — verified available on managed Postgres providers) · **local embeddings via Transformers.js/ONNX**, model vendored and offline-pinned · **`docx-templates` (MIT)** for formatting-preserving population, `mammoth` + `unpdf` for extraction, `pdf-lib` only for real AcroForms · **one transactional email API**. **REJECTED with reasons:** LangGraph and the Claude Agent SDK (see A0c) · a dedicated vector service (N services under per-client deployment, or a revived co-tenancy problem) · `docxtemplater` (core MIT/GPL but images/HTML/tables sit behind ~14 paid modules) · OAuth mailbox sending (bounces arrive as human-readable DSNs, not structured data).
8. 🚨 **pg-boss LANDMINE inherited:** any task touching pg-boss inherits the `perJobResults` vendored-API landmine from the register. If the approval queue rides pg-boss, that task owns it.

---

## Scope resolved by the owner (2026-08-07)

- **Document search STAYS IN.** Rev 1 dropped it as a side-effect of the template reframing; the owner restored it. This also **repairs A4**: the retrieval-boundary injection design (scan the few chunks a query returns, cache verdicts by content hash) was built for exactly this surface and had no home without it.
- **Sending documents IS in v1.** This is a net positive for sequencing: it exercises the approval spine end-to-end on the lowest-stakes channel, so the lifecycle problems in A5 (staleness, partial execution, delivery failure) surface on email before voice inherits them.

**Consequence — document ingestion is SHARED infrastructure.** Templates are documents; her contracts are documents. Both need files in the system, attached to a resolved client, using the entity linking that already exists. Built once, both features ride it — which is why search costs materially less on top of ingestion than it would as a standalone track. Track C is therefore one arc, not two.

**Two dependency trades this creates, recorded here per constraint #7 rather than discovered at implementation:** (a) a delivery channel (email or equivalent) with bounce/failure handling; (b) an embedding model and vector storage for search — likely a new Postgres extension plus a migration. Both need an explicit recorded decision at their task; neither is pre-accepted.

---

## Entry work

- **E2 — test-directory typecheck slice.** `tsconfig.test.json` + `tsc --noEmit`. Verified: vitest typechecks no tests today, so errors there are silent. Cheap, early, everything downstream benefits.
- **E3 — ✅ RESOLVED BY THE OWNER, 2026-08-07: PER-CLIENT DEPLOYMENTS, shared host + separate database per client.** Each customer's data lives in their own database; infrastructure is shared so one operator can maintain a fleet. **Self-hosting on a customer's own infrastructure is a supported deployment shape, not a fork** — same artifact, same "one configured tenant," pointed elsewhere. 🚨 **Design constraint that follows:** any health/telemetry surface must be **push-based** (each deployment reports outward) and never poll-based, or self-hosted clients behind a firewall become unsupportable. Phase 4 owns the fleet health view; do not build a polling assumption into anything before then. Each customer gets their own stack and database; one configured tenant per deployment, permanently. E3's remaining work is therefore *bookkeeping, not a decision*: **strike the multi-tenant defect family as OUT-OF-MODEL** (analytics tenant partition, RLS no-context fallback, per-tenant-per-source secrets, agent caller-identity scoping, tenant-blind webhook doors, tenantless queue envelope) citing this decision, and update KNOWN-ISSUES so the derived scoreboard reflects it. 🚨 **Do NOT remove the tenant plumbing itself** — faithful tenant propagation is what makes "one configured tenant" enforceable; the struck defects were about *separating co-resident tenants*, which no deployment will ever do. Accepted trade, recorded: per-client is simpler for isolation and harder for operations at scale (N databases, N upgrades) — fine at this stage, revisited only if that scale arrives.
- **E1 — CLOSE-4 exit-code wave. DECOUPLED from the critical path.** Nothing in the spine touches CLI exit codes. Requires an owner port window; land it any time before phase close. Carries the researched sysexits scheme, a 53-assertion blast radius across 7 CLI test files, and the known `chaos.sh` collision (it treats backfill `exit 1` as *resumable*, so moving unreachable-source to `75` inverts that branch).

---

## Track A — the safety spine

**A0a — Writer-boundary ADR (before any code).** A1–A3 require INSERTs; the agent cannot write. Name the writer. Options: (a) the host process — already the full-privilege app role — writes proposals on the agent's behalf, and the agent's only output is a validated object handed back across the MCP boundary; (b) a third `switchboard_proposer` role with INSERT-only on one append-only table, with the existing ACL tests *extended* rather than relaxed. Either way constraint #2 holds.

**A0b — ✅ APPROVER DECIDED BY THE OWNER (2026-08-07): THE CLIENT APPROVES, through their own dashboard. Not us.** This is a scope decision, not just an identity one, and it changes A0b materially: the approver is the *broker*, a non-technical business user, so approval cannot be a CLI flag and cannot rest on shell access. **Phase 3 therefore owns a minimal, authenticated, client-facing approval surface** — not the full Phase-4 dashboard, but real: a user record for that deployment's client users, a login, a session, one page listing pending proposals with approve/reject, and the audit row naming *her* user id. Without it, Phase 3's core value cannot be exercised by the person it is for, and the first demo would have to be given by us on her behalf — which is exactly the thing the approval gate exists to prevent.
🔗 **Synergy to exploit:** C5 builds transactional email with her domain authenticated. **Magic-link authentication rides that same channel** — no password storage, no reset flow, and one fewer credential for a non-technical user to lose. 🔬 **ADR-2 corrected the sequencing:** C5 sits late on the critical path while the approval surface is what makes A2 exercisable at all, so **stubbing the send behind the same interface is the EXPECTED path, not the fallback** — otherwise A2 ships with no way for the actual approver to use it.
⚠️ **What this does NOT become:** a multi-user permission system, roles, or org hierarchy. One deployment, one client, the small set of people at that client who may approve. Constraint #4 still binds — do not build tenancy machinery here.
🔬 Research found **no prior art for approver identity** in either engine examined, so this is deliberate design rather than an adopted pattern; say so in the ADR.

**A0c — ✅ FRAMEWORK DECISION SETTLED BY RESEARCH: hand-roll the loop. No framework, no agent SDK.** The ADR is now a *write-up*, not an open question — two vendor citations decided it:
- **Anthropic's own Tool Runner docs:** *"When you need human-in-the-loop approval… use the manual loop instead."* The SDK that would have been the middle path tells you not to use it for our case.
- **LangGraph's docs:** a resumed node *"re-runs from the beginning… so any code before the `interrupt` runs again"* — a **double-fire hazard aimed directly at the constraint being sold**. Approve one call, place it twice.
The middle path (hand-rolled state + framework loop) is coherent in principle, but every candidate loop-provider disqualifies itself on the exact seam we would be buying. Hermes Agent was already rejected on architecture (self-improving skills, shell-capable tooling, not multi-tenant, daemon not library). **Write the criteria table for the record** — provider portability is now an explicit criterion, since a per-client product will meet a client with their own LLM arrangement.

**A1 — Action and intent objects, and the tool-call boundary.**
🚨 **CORRECTION from ADR-1 (the plan was wrong about our own code):** rev 2 claimed the host process is "already the full-privilege app role." **It is not** — `agent/src/host/run-report.ts:8` builds the host's only pool from `agentConnectionString()`, which resolves to the read-only `switchboard_agent`; the full-privilege role lives on the ingest side. **The agent host holds no writable connection at all today.** A1 therefore inherits unpriced work: a second writable pool in the host, **plus a containment rule keeping it unreachable from the MCP tool surface** — without that rule, adding a writer to the agent's own process hands the agent write access through a side door, defeating the differentiator constraint #2 protects. Pin the containment, not just the pool.
Typed, immutable proposal: what, to whom, with what payload, derived from which records, with an idempotency key.
🔬 **Research changed this: there are TWO loops, not one.** Text (Anthropic) is turn-based; voice (Gemini Live) is a persistent socket session whose docs state it *"doesn't support automatic tool response handling."* They cannot be one loop. **What they share is a single normalised `ToolCall` type — because that is what the allowlist and the approval gate operate on.** One safety surface, two transports. Author tool schemas to the Gemini OpenAPI subset (the narrower of the two), and **disable parallel tool calls on the voice path** (name-based correlation cannot disambiguate them).

**A2 — The approval queue.** Approve / reject / amend-then-approve. Standing approvals per *category*, never blanket. Rejection reasons captured.

**A3 — Agent-decision audit log.** Every proposal, decision, execution, outcome, and **the configuration snapshot in force** (under per-client deployment this is a config snapshot, not a tenant row — do not build tenant machinery to satisfy it). This table does not exist today; it is new work, not an extension.

**A4 — Injection defense, re-derived against the boundaries that actually exist.** Rev 1 carried a retrieval-shaped design over from the RAG scope that was then removed. The real boundaries: **(i)** mart free-text reaching a prompt (exists today, partially fenced by `fenceUntrusted`); **(ii)** a customer template body entering the C3 reviewer's context — read in full, every use, so hash-cached verdicts are the cost control; **(iii)** call transcript text returning from voice into any downstream prompt or record; **(iv) 🚨 template ingestion as an EXECUTION boundary** — `docx-templates` documents an `EXEC` command and depends on Node's `vm`, so a customer-supplied template is a code-execution surface, not merely untrusted text. Decide the tier per boundary. Detection is defense-in-depth; the read-only role and approval queue remain load-bearing.
⚠️ **Existing-code finding:** `AnthropicLlm.complete` swallows every error and returns template text. Correct for a weekly report (it must always generate); **silently dangerous in an action path**, where a failure must stop rather than produce a plausible-looking result. The action path needs its own failure semantics.

**A5 — The action lifecycle state machine — enumerated and pinned before any action type is added.** This is where the cost actually lives, and rev 1 omitted all of it.
🔬 **Research: this is NOT a saga** — Switchboard's actions are not compensatable (you cannot un-send an email or un-place a call). It is a composite of four mechanisms: **idempotency key · outbox-ordered execution · execution-time re-validation · optimistic concurrency.** The rule to carry into every brief: **the key protects against repetition; re-validation protects against change.** Established shape (Temporal's semantics, implemented on our own Postgres): durable state + typed resume signal + validate-before-accept. Neither Temporal nor LangGraph offers approval **expiry** as a primitive, and neither addresses **approver identity** at all — A0b is genuinely unguided by prior art. 🚨 Do **not** name a table "outbox": migration 011 deliberately renamed `ingest.outbox` → `ingest_journal`.
- **Staleness:** a proposal is immutable, the records it derived from are not. Re-validate at execution; refuse on drift.
- **Partial execution:** the call connects, the outcome is captured, the audit write fails. Idempotency prevents double-send; it does not define half-executed state.
- **Expiry and re-proposal:** TTL, "expired unapproved," re-proposal semantics.
- **Concurrent approval:** two operators, one proposal.
- **Cost and rate limits:** budget cap, circuit breaker, behaviour on quota exhaustion — in a system whose doctrine is that every degraded condition reaches a human.
- **Vendor secrets** join the existing fail-closed gate.

---

## Track B — the question console

**B0 — Warehouse models for a FIXED question set (dbt work, comes first).** `customer_360` has no time dimension, so rev 1's promises were unbuildable. Needs: a time-grained model, last-activity across sources with a defined silence threshold, and an event-level history model — each with dbt tests and the `verify-dbt-warns` contract. **Fix the question list at design time**, the same discipline applied to actions; every new tool widens the read surface, and the allowlist is only a differentiator while it stays short and each entry is justified.

**B1 — Query surface + tools** over B0's models, each added to `READ_TOOLS` deliberately.

**B2 — Honest refusal, extending the existing doctrine.** Not new behaviour: `report.ts` already refuses mixed-currency totals and names the reason. Reuse that vocabulary or the console invents a second dialect of refusal.

**B3 — Provenance on every answer** — each figure names the records behind it.

---

## Track C — documents: ingest → populate → review → render → send → search (the largest track)

Rev 1 presented A/B/C/D as comparable. They are not: C is roughly 3× B and 2× D's engineering content, and C2 alone carries the differentiator claim.

**C1 — Document ingestion + template upload, built against SYNTHETIC templates. NOT human-blocked (owner correction, 2026-08-07).** Rev 2 treated this as blocked on receiving the broker's real templates. **That was wrong, and the correction changes the feature from consulting into product:** templates are **user-uploaded DATA**, not per-customer configuration. If we wire her specific documents in, every revision she makes becomes a change request to us — a service business. If she uploads them herself, her process stays alive without us in the loop.

Build against a synthetic corpus that exercises the format space: a Word document with simple blanks, one with tables, one with a header/logo/footer, one with nested formatting, one deliberately malformed. Handling those means handling hers. 🔬 Libraries settled by research: **`docx-templates` (MIT)** for formatting-preserving population, **`mammoth` + `unpdf`** for extraction, **`pdf-lib`** only for real AcroForms. 🚨 Template ingestion is an **execution** boundary (constraint #3).

**C1b — Placeholder mapping, done by the customer, once per template.** The design question the upload model opens: when she uploads a template with a blank, how does the system know it means *purchase price*? Answer that keeps it hers: **upload → the system discovers the placeholders → she maps each one to an available field → the mapping is stored with the template and reused forever.** Minutes of setup per template, by her, never revisited unless she changes the document. The honesty doctrine falls out for free: **an unmapped placeholder is left blank and flagged, never guessed** — identical treatment to a value that cannot be verified.

**Shared infrastructure, two jobs:** the same upload path feeds template population *and* C6's document search (contracts, correspondence, reports), everything attached to resolved client identities via the existing entity layer. It also shares the authenticated dashboard shell with A0b's approval surface — same login, same UI. Build once.

**C2 — Deterministic field resolution.** Each placeholder resolved from a verified source, with per-field provenance. **A value that cannot be verified leaves the field blank and flagged** — never guessed. Requires E3 resolved.

**C3 — The bounded reviewer.** Catches the failure nothing else can: every field individually valid, the document as a whole wrong (buyer/seller inverted, mismatched addresses across clauses, financing section populated for a cash buyer, dates out of order, inapplicable boilerplate). **Both constraints are their own tasks with claim-pinning tests:**
- **C3a — one-way merge.** The function combining reviewer output with field state is *structurally incapable* of `flagged → clear`. Pinned by feeding a reviewer response that says "this is fine" to a flagged field and asserting the flag survives. Same move as `registerReadOnlyTool`.
- **C3b — typed concerns, no prose channel.** "Cannot say this looks correct" is unachievable by prompting. The only structural version: the reviewer returns a **typed list of concerns** (empty = silence), the prose channel is discarded and never surfaced, and the UI renders *"0 concerns raised — this is not a verification"* as fixed text the model never authored. **If C3 ships with free text reaching a human, the constraint is decorative and the plan promised something it did not build.**

**C4 — Document render** to a file the customer reviews and signs. Assembly from their vetted template, not legal drafting.

**C5 — Delivery. IN V1 (owner, 2026-08-07).** Propose → approve → send, as a first-class action on the spine. Delivery outcome recorded on the client record and in the audit log.
🔬 **Research settled the shape:** a transactional email API, with **the broker's own DKIM TXT record and Return-Path CNAME in her DNS** so mail comes from her domain. **OAuth mailbox sending is rejected for v1** — bounces arrive as human-readable delivery notices, not structured data. 🚨 **Two cautions:** (a) *"just add an SPF record"* is advice that **can break her existing mail** (RFC 7208 lookup limits) — treat her DNS as a careful change, not a checkbox; (b) **bounce webhooks are INBOUND and collide with E3's push-only constraint for self-hosted clients** — an outbound-poll fallback is required, or delivery reporting silently fails for exactly the enterprise deployments we said we support. Deliberately the *first* real outbound action built: lowest stakes, reviewable before it goes, and it forces A5's lifecycle states into the open on a channel where a mistake is embarrassing rather than irreversible. Dependency trade (channel choice) recorded at this task.

**C6 — Document search. IN SCOPE (owner, 2026-08-07).** Ask a question, get an answer from her actual documents — *"what did we agree with the Suarez family about the inspection contingency?"* Builds on C1's ingestion, so its marginal cost is chunking + embeddings + vector storage + retrieval, not a second ingestion pipeline. **Our differentiator applies here and nowhere else in the market:** retrieved passages are attached to *resolved client identities*, so an answer can be assembled across a client's documents, deals, invoices and tickets at once — the comparables research found no open-source project combining integration, identity resolution and an AI layer at this tier. **This is the boundary A4's retrieval-tier design was built for** (scan the few chunks a query returns; cache verdicts by content hash; model tier local). 🔬 **Research settled the stack:** **pgvector with an HNSW index, in the client's existing Postgres** — verified available on the managed Postgres providers Phase 4 would use, and the right shape when every client already has their own database (a dedicated vector service would mean N services, or a revived co-tenancy problem). 🚨 **pgvector's `vector` type caps at 2,000 dimensions, so the embedding dimension is pinned NOW (1024)** — this is not a later decision. **Embeddings run LOCALLY** (Transformers.js/ONNX, model vendored and offline-pinned, remote model loading disabled and pinned by test): the driver is not cost (hosted is cents) but **RA 10173 accountability for transfers abroad** — a broker's client contracts should not leave her deployment — plus deprecation control. A hosted embedder sits behind the same interface as an opt-in. ⚠️ **Honest gap:** retrieval *quality* of a local model versus a hosted one was **not verified** — no benchmark was opened. **Settle it by measurement at C6, not by assumption.** Sequenced last in Track C because everything before it is prerequisite and it is the only purely additive piece.

---

## Track D — the outbound voice agent

**D1 — ✅ SPIKE COMPLETE (2026-08-07). Bridge chosen: LiveKit Cloud + Twilio SIP trunk.** Full write-up `.superpowers/sdd/d1-voice-vendor-spike.md`.
- **Filipino IS documented on the Live API specifically** — its capabilities page lists 97 languages including `fil`. Nuance: native-audio models choose language automatically and do not accept an explicit language code; steering is via system instructions.
- **🔑 THE SELF-HOSTED CONSTRAINT DECIDED THE VENDOR, not price.** LiveKit's docs: agent servers *"do not need to expose any inbound hosts or ports to the public internet"* — call progress arrives as participant attributes over the same outbound session. **Twilio direct conflicts structurally**: it dials *into* our socket and fetches instructions from a public URL; call state could be polled, but **the media stream cannot be**, so self-hosted Twilio needs a hosted relay — which is what LiveKit Cloud already is. Record this as the *reason* for the choice.
- **Cost ≈ $74/mo** for 200 PH-mobile minutes ($58.76 termination + $15 number; LiveKit SIP $0.004/min, **$0 at this volume** inside its free tier). Twilio direct was $74.64 — within a dollar. **~98% of the bill is carrier minutes**, so this was an engineering decision, never a cost one.
- **Barge-in passes through cleanly** on both paths (LiveKit defers interruption to the model's server-side turn detection; Twilio has an explicit clear/mark protocol — which also closed the prior pass's codec gap: μ-law 8 kHz).
- **Disqualifiers to watch:** the LiveKit Gemini plugin lagging the Live API (its docs already flag compatibility limits on the current preview model), or measurably worse barge-in latency through the SIP leg.
- **⚠️ Still open — do not treat as settled:** Telnyx's PH termination rate (sales-gated; the correct country URL was found and its raw HTML carries only global "starting at" figures — **no Telnyx cost may be quoted**) · **Taglish code-switching quality, documented by nobody — empirical test required before the feature is promised** · whether PSTN-side buffered audio truncates on interruption (measure on the first live call) · Gemini Live token pricing · NTC rules on AI-placed calls, which bear on D5 — **build the disclosure toggle on-by-default regardless.**

**D2 — Bounded confirmation calls.** Appointment confirm/reschedule: short script, enumerable outcomes (confirmed / rescheduled / no answer / callback). Rides the approval spine end to end.

**D3 — Intake calls (owner addition, 2026-08-07).** Structured capture from a fluid conversation: budget, area, requirements, timeline, financing. **Lower risk than open Q&A and a better architectural fit** — the agent *asks* rather than asserts, makes no commitments, and its output is structured data landing on a client record, which is what Switchboard is for. Success is measurable (fields captured), so honest partial results apply naturally: *"captured 6 of 8; timeline and financing not obtained."* Two notes: consent posture differs (newer leads vs onboarded clients — a per-tenant setting), and it may be a prospect's **first impression** of the business, so Taglish quality matters more here than anywhere. **✅ ORDER DECIDED (owner deferred to systematic judgment, 2026-08-07): D2 before D3.** Reasoning, on build-order grounds rather than value: D2's script is short and its outcomes are a closed set (confirmed / rescheduled / no answer / callback), so the whole path — propose → approve → dial → capture outcome → audit — is provable with minimal conversational surface. D2 also calls **already-onboarded** clients, so the consent story is clean; D3 reaches newer leads, where the consent toggle path is thornier. And D3 adds structured-capture logic (field definitions, partial-result semantics) on top of a call loop that D2 will already have proven. **✅ Owner settled the delivery question too (2026-08-07): NOTHING is shared with the broker until BOTH D2 and D3 are built.** So there is no ship-to-her-first question at all — build order is purely technical, and the phase close is the delivery point. This is deliberate scope-creep protection: no mid-phase demo deadline means no pressure to rush one call type to a showable state, and no half-built capability shaping decisions about the other. Consistent with the owner's standing position that nothing is shown until it is finished.

**D4 — Open-ended client Q&A: DEFERRED to 3b.** Improvising in the customer's voice, live, unreviewable before it is said.

**D5–D9 — Compliance toggles, one task each** (rev 1 hid five enforcement behaviours in one bullet; each is a check with a refusal path and an audit line): AI disclosure at call start (on/off + editable wording) · consent-required (refuses to call a client whose record lacks recorded consent) · calling windows · recording on/off · attempt limits and do-not-call.
🔬 **Research changed WHEN these run: they are EXECUTION-TIME checks, not approval-time.** Rev 2 said this nowhere. Approval on Tuesday does not make a Thursday call permitted — the calling-window, consent and do-not-call checks must all re-evaluate at execution. This is the same principle as A5's re-validation rule.

**D10 — Transcript and recording retention/erasure.** The most sensitive data this system will ever hold. `docs/gdpr-erasure-design.md` exists; extend it. PH RA 10173 implications flagged as *unresearched, not settled*.

**D11 — The customer provisions the phone number.** PH local numbers require business registration, a mayor's permit and an in-region address — so it is in the broker's name. Better anyway: her caller ID, her regulatory posture, us out of that chain.

---

## Definition of done — split, per the register's directive

**Public repo (the phase gate):** console answers the fixed question set and refuses unverifiable questions with provenance · a populated template is correct with unverifiable fields visibly blank and the reviewer structurally unable to bless it · **a MOCK telephony vendor** in the existing `mocks/*` paradigm pattern exercises propose → approve → execute → transcript/outcome, fully CI-runnable · nothing reaches the outside world without an identified approval · **injection defense holds against a named adversarial test set** — a task must create it, state its size and define the pass bar, evaluated per the register's `pi-detector-bench` position (hai-guardrails publishes no accuracy numbers) · full gauntlet green, register swept, docs true at head with counts mechanically derived.

**Engagement-side (tracked separately, NOT a phase gate):** the real LiveKit/Twilio bridge and a live call, gated on the broker's number and business registration. Rev 1 made phase closure depend on a third party's carrier KYC; that was wrong.

---

## Risks

1. **Scope has no natural edge.** Mitigation, corrected: a **fixed action list** *and* **the action lifecycle state machine (A5) enumerated and pinned before any action type is added.** Rev 1's mitigation bounded only the action surface, while the cost lives in the per-mechanism lifecycle. Once A5 holds, a new action is genuinely cheap — which is the property being claimed.
2. ~~Track C's format is unknown until the broker's templates arrive~~ **RETIRED (owner correction, 2026-08-07):** templates are user-uploaded data handled generically, built and proven against a synthetic corpus. The residual risk is narrower — that real-world documents contain a structure the synthetic corpus omits — mitigated by making the corpus deliberately adversarial (tables, headers, nesting, malformed input) rather than by waiting.
3. **Voice depends on an external chain** we do not control; D1 runs early to surface failure while it is cheap.
4. **Two dependencies are production-proven in the owner's other product** (Gemini Live, hai-guardrails) — but neither has been exercised against *this* threat shape or *this* transport. Verify, do not assume.

## Sequencing

**Parallel from day one:** `C1` (synthetic-corpus format work — **no longer blocked on the broker**) · `D1` (vendor spike — procurement, ours to run) · `E2` (typecheck slice). **Nothing in this phase waits on the customer.**
**Critical path:** `A0a/A0b/A0c` (ADRs) → `A1–A3` → `A4` → `A5` → `B0` → `B1–B3` → `C2–C4` → **`C5` (send — the first real outbound action, deliberately before voice)** → `D2`/`D3` + `D5–D11` → **`C6` (search — purely additive, last)**.
**Any time before close:** `E1` (needs an owner port window). **Before C2:** `E3`.

## What research could NOT verify — settle by measurement, not assumption

Recorded so nobody later mistakes an open question for a settled one:
- **Retrieval quality of local vs hosted embeddings** — no benchmark opened. The load-bearing gap in the C6 decision. Measure at C6.
- **Gemini Live's exact tool-call wire field names** — the guide and REST reference rendered differently; verify at implementation.
- **Whether *any* agent framework offers mandatory, non-bypassable human-in-the-loop** — only two candidates were checked, so the claim is limited to those two.
- **Approver-identity prior art** — none found. A0b is genuinely unguided; design it deliberately.
- **Cost/rate-limit circuit-breaker prior art** — none found; that part of A5 is reasoned design, not citation.
- **Several licences and pricing pages** (mammoth, pdf-lib, docxtemplater modules, Resend's DNS list) and **NPC implementing rules on cross-border transfer** — confirm before the dependency lands.

## Open decisions (owner)

1. ~~RAG deferred or restored~~ — **RESOLVED: in scope** (C6). ~~Send in v1~~ — **RESOLVED: yes** (C5).
2. **Isolation model** (E3) — and the disposition of the four tenancy defects.
3. **D2 or D3 first** — confirmations or intake; ask the broker which costs her more time.
4. **Embedding/vector-storage choice** (C6) and **delivery channel** (C5) — both are dependency trades needing an explicit recorded decision at their task, not a default.
