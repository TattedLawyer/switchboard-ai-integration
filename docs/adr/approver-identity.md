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
