# ADR: approver identity — the client approves, through an authenticated surface we own

**Status:** accepted (Phase 3, plan item A0b) — decision recorded, not yet implemented
**Owner decision:** 2026-08-07 — the CLIENT approves, through their own dashboard. Not us.
**Applies to:** A2 (approval queue), A3 (audit log), C1's dashboard shell, C5 (delivery channel)
**Plan:** `docs/superpowers/plans/2026-08-07-phase3-agent-layer.md` (A0b; global constraints #1, #4)
**Review that raised it:** `.superpowers/sdd/phase3-plan-review.md` (Blocker B-5)

## Problem

Global constraint #1 says nothing acts without approval by an *identified* approver. Today there
is nobody to identify.

Verified in this repo, not assumed:

- There is no user table, no session table and no login anywhere. `ingest/migrations/` runs
  `001`–`013` and contains none.
- The operator CLIs authenticate nobody. `ingest/src/cli/gap-ack.ts` is the closest thing to an
  accountable action in the system and it is instructive: it *refuses to act anonymously*
  (`:124-128`, "refusing to acknowledge a permanent data loss anonymously: --by <operator> is
  required") and records `acknowledged_by` on the row (`:142-151`). But `--by` is a free-form
  string the caller types. The file's own header (`:15-18`) says the design intent plainly. It is
  attribution, not authentication.
- The only authentication in the codebase is HMAC authenticity on inbound vendor webhooks, which
  authenticates a *vendor*, not a person.

So an approval queue built on the existing surface would attribute every outward action to
"whoever can run the CLI." An audit trail that names a shell user is not evidence a customer can
rely on, and A3's product claim — that this is what lets a customer account for their own
practices later — would be worth nothing.

## 🔬 No prior art. This is deliberate design.

`.superpowers/sdd/p3-agent-architecture-research.md` (Q3) examined the two mature
human-in-the-loop traditions and found **neither addresses approver identity at all**:

- LangGraph's `interrupt` resumes on a `thread_id`; nothing in
  `https://docs.langchain.com/oss/javascript/langgraph/interrupts` authenticates who sent the
  resume value.
- Temporal's Signals and Updates carry no authenticated principal in anything the researcher read
  (`https://docs.temporal.io/develop/typescript/message-passing`,
  `https://docs.temporal.io/encyclopedia/workflow-message-passing`).

The research states the limit of that claim explicitly and this ADR carries it forward rather than
smoothing it: **only two candidates were surveyed.** The verified finding is "neither of the two
engines examined addresses approver identity," not "no system anywhere does." Either way, there is
no standard here to adopt or to shortcut past. What follows is designed, not inherited, and should
be read as such.

## Decision

**Phase 3 owns a minimal, authenticated, client-facing approval surface.** Not the Phase-4
dashboard — but real, and the client uses it herself.

The scope of "minimal", enumerated so it cannot drift:

1. A **user record** for that deployment's client users.
2. A **login**.
3. A **session**.
4. **One page** listing pending proposals, with approve / reject (and amend-then-approve, per A2).
5. An **audit row naming her user id** — the actual identifier of the actual person, resolvable to
   a human the customer can name.

That is the whole surface. Nothing else in Phase 3 depends on it existing beyond this.

### Why the approver cannot be us, and cannot be a CLI

The owner's decision is a scope decision as much as an identity one, and the consequence is
forcing:

- **The approver is the broker — a non-technical business user.** Approval therefore cannot be a
  CLI flag, and cannot rest on shell access. The `--by <operator>` shape that works for
  `gap-ack` (an engineer acknowledging a data gap) does not transfer to a real-estate broker
  approving an outbound email to her own client.
- **If we approve on her behalf, the gate is decorative.** The first demo would be us operating
  the approval queue for her — which is precisely the arrangement the approval queue exists to
  prevent. A constraint whose only exerciser is the party the constraint protects against is not
  a constraint.
- **Without it, Phase 3's core value cannot be exercised by the person it is for.** Everything
  else in the phase — proposals, lifecycle, audit — terminates in a decision nobody in the
  customer's organisation can make.

## Recommended authentication mechanism: magic link (email one-time link), with caveats

**Recommendation: magic-link authentication, riding the transactional email channel C5 builds.**

The reasoning, with the sourced part separated from the judgment:

**Sourced.** C5's research (`.superpowers/sdd/p3-document-layer-research.md`) settled that Phase 3
will stand up a transactional email API with the broker's own domain authenticated by a DKIM TXT
record and a Return-Path CNAME in her DNS (see that document's C5 section and its sources:
`https://resend.com/docs/dashboard/domains/introduction`,
`https://resend.com/docs/dashboard/domains/dmarc`, plus Postmark's DNS guidance). A reliable,
authenticated, machine-observable email channel to the client is therefore being built regardless
of how we authenticate her.

**Judgment (the plan's observation, and this ADR agrees with it).** Given that channel exists,
magic links cost almost nothing extra and remove two failure modes outright: **no password
storage** (no hashing scheme to get right, no credential to leak from a per-client database) and
**no reset flow** (which is the same email round trip as the login, so building both is building
one thing twice). For a single non-technical user, one fewer credential to lose is a real
operational saving, not a stylistic preference.

**Caveats this ADR will not smooth over:**

- **A magic link is a bearer token in an inbox.** Anyone with access to that mailbox can approve.
  Mitigations belong in the A0b implementation brief, not here, but the shape is standard: short
  expiry, single use, invalidated on use, bound to the requesting session, and — because these
  links authorise outward actions — an audit row for every login, not only for every approval.
- **Auth availability becomes coupled to email deliverability.** If her domain's mail is
  misconfigured, she cannot log in *and* the system cannot send. The C5 research already flags
  that "just add an SPF record" is advice that can break existing mail (RFC 7208 lookup limits)
  and must be treated as a careful DNS change. That caution now covers login too, which raises its
  stakes.
- **Sequencing tension, stated rather than hidden.** The plan suggests sequencing A0b after C5's
  channel exists, or stubbing the send behind the same interface. But C5 sits late on the critical
  path (`A0 → A1–A3 → A4 → A5 → B0 → B1–B3 → C2–C4 → C5`), while the approval surface is what
  makes A2 exercisable at all. **The stub is therefore the expected path, not the fallback:**
  build A0b against a send interface with a local/mock implementation, and swap in C5's real
  channel when it lands. *(Judgment. This is a disagreement with the plan's ordering emphasis,
  recorded deliberately.)*
- **A password fallback is not forbidden**, but it is not the recommendation, and adding one later
  should be an explicit decision with its own note — not something an implementer reaches for
  because the mail stub was inconvenient.

## ⚠️ Scope bound — what this does NOT become

**No roles. No permission matrix. No org hierarchy. No multi-tenancy.**

One deployment. One client. The small set of people at that client who may approve. Every one of
them can approve anything in the queue; the audit row records which one did.

Global constraint #4 binds here without exception: *do not invent a multi-tenant SaaS model.* Under
the E3 decision (per-client deployments, shared host, separate database per client, self-hosting
supported), there is permanently one configured tenant per deployment. A permission model would be
machinery built for a shape that will never exist.

The specific things a reviewer should reject on sight in an A0b implementation:

- a `roles` or `permissions` table, or a role column on the user record;
- an approval routing rule ("proposals over $X go to Y");
- an organisation/team/workspace entity;
- anything that makes the user table queryable across tenants.

If a task appears to require any of these, that is a **STOP-and-report**, per constraint #4.

## Consequences

- The audit row's approver field is a **user id in this deployment's user table**, not a string.
  A3's schema should make it a reference, so an unattributed approval is not representable.
- The authenticated shell is **shared with C1's document upload surface** — same login, same UI,
  built once. C1's brief should assume it rather than building a second entry point.
- `gap-ack`'s `--by` is not superseded. It is an operator tool for an engineer, and its honest
  attribution-not-authentication framing stays as it is. **Two different accountability models
  coexisting is correct here**; what would be wrong is letting the CLI model creep into the
  client-facing approval path.
- The KNOWN-ISSUES / honesty pass for this phase must state plainly what the mechanism is and what
  it is not, per the research note: A0b's honesty line is *necessary*, not a placeholder awaiting
  an industry standard that does not exist.

---

# Addendum (Phase 3 / A2) — what the approval queue does and does not buy

A2 built the queue this ADR anticipated: `approval.users`, `approval.decisions`, the
eight-state lifecycle, and a `BEFORE UPDATE` trigger. This addendum records what the
mechanism guarantees, what it deliberately does not, and the designs that were rejected on
the way — because every one of those rejections was reached twice, and a record is cheaper
than reaching it a third time.

## The claim A2 makes, in the only words that survive review

> **No proposal can transition to `approved` or `rejected` without an atomically-written
> `approval.decisions` row of the matching kind naming an approver — so a human disposition
> with no attributable human is not representable.**

Three things make it true rather than aspirational, and all three are pinned:

- the row and the transition are in **one transaction**, discriminated by an `xid8` column
  defaulting to `pg_current_xact_id()`, so a decision committed at any point in the past
  does not authorise a transition made now;
- the kind must **match** — `approval.decisions` is multi-row per proposal by design,
  because every "Not now" adds a `dismissed` row, and without the match one of those would
  approve a proposal;
- the predicate covers **`rejected` as well as `approved`**. Scoped to `approved`, a bare
  `update approval.proposals set state='rejected' where state='pending'` was *measured* to
  succeed: `UPDATE 6`, zero decision rows, no error. A rejection is a human decision, and
  if the database does not require the human then the word is not evidence of one.

**Machine-driven terminal transitions are deliberately exempt, and that exemption is the
whole content of the rule.** `pending → expired` (the sweeper) and `pending → superseded`
(amendment, and render-time duplicate collapse) carry no decision row **because nobody
decided**. It is also why the emergency manual drain now targets `expired` rather than
`rejected`: an operator draining a wedged queue is not deciding anything, and recording
their bulk action as a rejection would put a decision in the audit trail that never
happened.

**The limit of the claim, which travels with it everywhere:** it says nothing about *who
pressed the button*. The database authenticates nobody and the agent host can reach the
approval service's credential. The credential-locality disclosure in `KNOWN-ISSUES.md`
governs that and is not superseded by anything here.

## 🚨 The reliability paradox — why the broker's attention is not what makes this safe

*(An earlier draft of this heading named the approval step and the word "safeguard" in one
line. It was changed because `ingest/test/approval-honesty.test.ts` red against it: the pattern anchors on a
subject plus an enforcement predicate and does not read negations, deliberately, since a
negation-aware pattern is one paraphrase away from being tuned to green. The rule this
document set for itself was "if a legitimate sentence trips the pin, fix the sentence" —
so the sentence was fixed. Recorded because the alternative was to relax the pin, which is
the failure mode this whole file exists to prevent.)*

This is the most counter-intuitive conclusion in the phase, it is the one most likely to be
quietly reversed by a future document, and `ingest/test/approval-honesty.test.ts` exists to
red when it is.

From Mosier & Manzey 2019 (postprint pp. 1–13): omission errors rose **32.4% → 48.3% as
decision-aid reliability rose .87 → .98** (Bailey & Scerbo 2007) · **back-end aids that
recommend one specific action are worse** than front-end aids · **experts are as
susceptible as novices** · **externally imposed accountability did not replicate in
professionals**, and debiasing that way *"does not show much promise."*

Our queue is the worst-configured aid in that literature: back-end, one recommendation, and
intended to become highly reliable.

> **As the agent improves, human approval provides LESS protection, not more. Safety rests
> on the read-only credential (A1) and the immutability trigger (A2's migration 015) —
> mechanisms that hold regardless of whether anyone read the card — and not on the broker's
> attention.**

**Three answers that are ruled out by the same evidence**, listed because each is the
obvious thing to reach for and all three were measured not to work:

- better **card design** — Firefox's "Add Exception" showed 85.4% confirmation barely
  varying by error type; users ignore the categories;
- more **warning text** or added friction — 84% proceeded through the extra dialog, and
  detail links drew 1.6% / 0% / 3%;
- **accountability** framing on the card — externally imposed accountability did not
  replicate in professionals.

Be suspicious of any future proposal that answers this paragraph with UI.

## What A2 does NOT attest

- **A2 does not attest what her browser painted.** It attests that the payload she approved
  cannot change, and that we recorded — *as audit metadata only* — which renderer version
  showed it to her.
- **It does not attest anything about the rendering at execution time.** A2 executes against
  any rendering whatsoever.
- **It does not bind the payload to the SMTP envelope.** Everything between the canonical
  payload and what the recipient receives is built by C5 and is outside anything A2
  guarantees. That is a C5 acceptance criterion: *the executor derives the entire outbound
  message from the bound payload, and any field it synthesises is either constant per
  deployment or displayed on the card.*
- **`renderer_version` is never a predicate.** It is recorded and it is not read in the
  request path.

## Rejected designs, recorded so they cannot quietly return

**The hold-then-send undo window (owner decision, 2026-08-08) — REJECTED, not deferred.**
It was research-derived rather than requested; it is fundamentally *a mechanism for not
asking the human*, which is backwards for a product whose differentiator is that the agent
cannot act alone; the automatic decision about which actions skip approval is the most
safety-critical logic in the system and two independent reviews defeated it; and there is
no volume problem to solve, because the broker has zero actions today. It would also have
falsified `README.md`'s published sentence that any action beyond reading requires human
approval. Revisit only if real usage produces evidence of approval fatigue, **and** there is
a real rendering and sending stack to test against.

**No gate and no classifier were built, and that is a decision rather than an omission.** A
classifier with one branch is not a classifier, it is a constant — and a constant returning
`'approval'` is the absence of a gate expressed as code, i.e. a ready-made re-entry point
for the design above, reachable by a refactor with no review attached.

**`presentation_hash` / the display binding — DELETED.** Two sentences are banned, not one,
because a one-item list did not catch the second last time:

1. *"what you approved is the screen you were shown, byte for byte"* — or any claim about
   what her browser rendered. The mechanism hashed bytes the **server** produced and
   compared them against a server-side re-render of the same immutable row at the same
   instant: both sides our own pure function of one input, so a proxied client, a browser
   extension, a CSS rule or a stale bundle posts back a correct hash of bytes it never
   displayed.
2. *"we will not execute against a rendering we no longer produce"* — the `renderer_version`
   runtime check. It had **no nameable threat** (the payload is immutable and the approval
   is attributable regardless of what rendered it) and a **concrete cost**: after any
   renderer deploy, every approved-but-unexecuted proposal would refuse execution
   permanently, destroying a real human approval with no recovery path in this workstream.
   The mechanism was deleted and *this sentence survived in the publishable set*, which is
   exactly how a deleted control becomes a published guarantee.

What survives is a **CI determinism property** — the payload region renders byte-identically
across processes, time zones, locales and clocks — which is where a determinism check
belongs.

**Standing approvals per category — dropped.** Execute-then-inform. There is no rendered
payload to bind to, and it is a low-risk bypass tier under a kinder name.

**`SECURITY DEFINER` transition functions — superseded.** They buy enforcement only for
callers who consent to use them, while importing PUBLIC-EXECUTE-by-default and the
`search_path` misuse surface.

## Three honesty sentences this phase owes, verbatim

**On the trigger (D3).** *"We enforce payload immutability and legal state transitions with
a database trigger rather than in application code, because a trigger has no bypass path.
We deliberately do not put the transition workflow in the database. The line between
'invariant belongs in the schema' and 'workflow belongs in the service' is our judgment; we
found no source that draws it."*

**On the user table (D4).** `approval.users` is a strict subset — `id`, `email`,
`created_at`, `disabled_at`, nothing else — so A0b's work is purely additive. The unique
index on `lower(email)` is **storage hygiene only and must never become a comparison
predicate**: `lower()` is not identity-preserving for mailboxes (U+212A lower-cases to `k`,
U+0130 collides with `i`) and RFC 5321 §2.3.11 makes the local part case-sensitive and the
mailbox owner's business. A2 performs no email comparison anywhere; A0b inherits this
warning. The first row is created by an operator through `ingest/src/cli/approval-user-add.ts`,
connecting as the migration owner — which gives someone a user id, **not a way to log in**.

**On the hash chain (D5, A3's scope).** *"A hash chain written and stored entirely on a host
the client controls is tamper-**evident**, not tamper-**proof**, and nothing we can build
changes that. Keying the chain with a secret stored on that same host adds no property that
an unkeyed SHA-256 chain does not already have. The control that matters is publishing the
chain head somewhere outside the host; from the last published head backwards, alteration is
detectable by anyone holding it. We will claim tamper-evidence with an external anchor once
A3 ships the chain and its anchor destination is settled — no hash chain exists in any
shipped path today. We do not claim tamper-proofing, and we do not claim tamper-evidence
against the host operator for any period after the last published head."* A2's whole
obligation towards it is that decision rows are append-only and therefore chainable, which
`42501` on UPDATE and DELETE delivers.
