# ADR: the agent loop is hand-rolled — no framework, no agent SDK

**Status:** accepted (Phase 3, plan item A0c) — settled by vendor documentation before any code
**Applies to:** A1 (the tool-call boundary), A2 (approval queue), A5 (action lifecycle), Track D (voice)
**Plan:** `docs/superpowers/plans/2026-08-07-phase3-agent-layer.md` (A0c; global constraint #7)
**Research:** `.superpowers/sdd/p3-agent-architecture-research.md` (Q1, Q2)
**Review that raised it:** `.superpowers/sdd/phase3-plan-review.md` (I-6 — the decision must precede the spine, not follow it)

This is a **write-up of a settled decision**, not an open evaluation. The Gate 0b reviewer's point
stands and is the reason this ADR exists before A1: a framework bake-off run *after* the spine is
built is theatre, because the spine is the thing the framework would have supplied. So the
decision is made here, with its reasons on the record, and the reasons are citations rather than
preferences.

## Decision

**Hand-roll the agent loop. Adopt no framework and no agent SDK. Zero new runtime dependencies.**

The loop itself is small: send `messages` + `tools`, read `stop_reason: "tool_use"`, dispatch the
call, append a `tool_result`, repeat. Anthropic's tool-use overview lays that round trip out in
full on one page (`https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/overview`),
against an SDK the repo already depends on.

## The two citations that decided it

Both are vendor documentation, and both speak to the exact seam Phase 3 is selling.

**1. Anthropic's own Tool Runner docs rule out the middle path.** The strongest version of "adopt
something for the loop only" was `toolRunner` — it adds no new package and comes from the SDK
already present. Anthropic's own page says not to use it for our case:

> "When you need human-in-the-loop approval, custom logging, or conditional execution, use the
> [manual loop] instead."
> — `https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner`

Phase 3 needs all three.

**2. LangGraph's resume semantics are a double-fire hazard aimed at the constraint being sold.**

> "the node re-runs from the beginning of the node where the `interrupt` was called when resumed,
> so any code before the `interrupt` runs again"; "Side effects called before `interrupt` must be
> idempotent."
> — `https://docs.langchain.com/oss/javascript/langgraph/interrupts`

For an approval queue whose entire product claim is *nothing outward happens without an approved,
audited decision*, a resume primitive that re-executes arbitrary preceding code is a lifecycle
hazard sitting directly underneath the claim. Approve one call; place it twice. The weeks the
framework saves would be spent proving it cannot double-fire.

The research attempted the case *for* LangGraph honestly and reports it partly succeeded —
`interrupt()` + `PostgresSaver` genuinely is A1+A2, durable and battle-tested — before failing on
this specific. That is the shape of the rejection: not "we prefer our own code," but "the primitive
misbehaves precisely where our differentiator lives."

## Criteria table

The project's criteria, not generic ones. Lifted from
`.superpowers/sdd/p3-agent-architecture-research.md` Q1 and condensed.

| Criterion | Hand-rolled | LangGraph JS | Claude Agent SDK |
|---|---|---|---|
| **State consistency** — truth lives in one Postgres store | **Best.** The action / approval / audit tables *are* the state. One store, one record of each decision. | **A second store, mandatory.** "To use `interrupt`, you need: 1. A checkpointer to persist the graph state." `PostgresSaver` lands in *your* Postgres but in *its* schema, thread-keyed, with `.put`/`.putWrites`/`.getTuple`/`.list` as the only contract — two records of the same decision that can disagree. | **A second store, opaque.** SDK-owned sessions maintain context across exchanges and resume or fork later; not Postgres rows we control. |
| **Per-step auditability** | **We own every row.** The audit write is in the same transaction as the state transition. | Checkpoints are a per-super-step state snapshot, not a decision ledger. A3 still has to be written by us — *and then reconciled against the checkpoints*. | The SDK owns the transcript; hooks let you observe it, not own it. |
| **Can the constraint be made MANDATORY rather than optional** | **Structural.** The approval check can be the only code path reaching an executor, pinned the same way `registerReadOnlyTool` (`agent/src/mcp/server.ts:16-26`) pins the allowlist. | **Opt-in by design.** `interrupt()` is a function a node calls. Nothing forces a node to call it; a node added later that forgets simply does not pause. | **Explicitly bypassable, by documented design.** `permissionMode: 'bypassPermissions'`; and the docs carry a standing warning that "Auto-approved tools never reach `canUseTool`… permission checks you put there are silently bypassed for that tool" (`https://code.claude.com/docs/en/agent-sdk/permissions`). The only always-runs hook is `PreToolUse`, documented as *the workaround*. |
| **Provider portability** | **Full** — we define the seam (see "two loops" below). | Model-agnostic via `@langchain/core`, but that is an abstraction inherited rather than controlled. | **Zero.** Claude models only, licence-bound to Anthropic's commercial terms. Gemini Live cannot ride it. |
| **Dependency weight** | **Zero new.** `@anthropic-ai/sdk` is already present. | `@langchain/langgraph@1.4.9` declares 4 direct deps plus peers `@langchain/core ^1.1.48` and `zod` (`https://registry.npmjs.org/@langchain/langgraph/latest`), *before* transitive closure, plus a separate checkpointer package for Postgres. | Pulls the whole Claude Code harness surface — built-in Read/Write/Edit/Bash tools, skills, plugins, MCP, subagents, settings-file loading from `.claude/` and `~/.claude/`. For a read-only agent, all of it is attack surface to switch off. |

The **"mandatory rather than optional"** row is the decisive one, and it is worth stating why in
plain terms: this repo's pattern for a constraint that matters is to make it structurally
unreachable, not documented. `registerReadOnlyTool` throws on any name outside `READ_TOOLS`
(`agent/src/mcp/server.ts:22-26`) — enforcement, not convention, and its own comment says so.
Neither candidate lets the approval gate be built that way. LangGraph's is a function you must
remember to call; the Agent SDK's has a documented bypass flag and a documented silent-bypass case.

### Unverified, carried forward rather than smoothed

- **LangGraph's true installed dependency weight** was not resolved — the registry manifest gives
  4 direct + 2 peers; the transitive closure was not walked, and npm's web page 403'd to the
  researcher. The real package count is higher than the figure above.
- **"No framework offers mandatory HITL" would be an overreach.** Only LangGraph and the Claude
  Agent SDK were examined. AutoGen, Mastra, the Vercel AI SDK and the OpenAI Agents SDK were not.
  The verified claim is narrower: *neither of the two candidates evaluated makes approval
  non-bypassable.*

## Hermes Agent — rejected on architecture

Recorded per the plan (A0c), which notes it was rejected before this research pass. **These
reasons come from the plan, not from a primary source opened in this pass — no Hermes
documentation was fetched for this ADR, and they should be re-checked if it is ever
reconsidered.** As recorded, the rejection grounds were:

- **self-improving skills** — an agent that rewrites its own capabilities is incompatible with a
  fixed, justified tool allowlist;
- **shell-capable tooling** — the opposite of a read-only agent with one declared read tool;
- **not multi-tenant** — noted at the time; under the E3 per-client deployment decision this is
  the least load-bearing of the four;
- **a daemon, not a library** — a separate process to run and upgrade per client, which the
  per-client deployment model makes a per-customer operations cost.

## There will be TWO loops, sharing one `ToolCall` type

This is the part of A0c that changes A1's shape, and it is why the shared type matters more than
the loop code does.

The two transports cannot be one loop:

- **Text (Anthropic)** is turn-based request/response.
- **Voice (Gemini Live)** is a persistent socket session, and its docs are explicit: "Unlike the
  `generateContent` API, the Live API doesn't support automatic tool response handling. You must
  handle tool responses manually in your client code." Declarations go in *session config*; the
  model emits a `toolCall` message; the client replies with `session.send_tool_response`.
  (`https://ai.google.dev/gemini-api/docs/live-tools`)

**What they share is a single normalised `ToolCall` / `ToolResult` value type — because that is
what the allowlist and the approval gate operate on.** One safety surface, two transports.
Provider differences (Anthropic keys results by `tool_use_id`, OpenAI by `call_id` on a JSON
*string* of arguments, Gemini by function *name* on an args *object*) are absorbed by a thin pair
of mapper functions per provider and never reach the gate.

The research attempted to refute the adapter — "just write the two loops twice" — and reports it
partly succeeded: the loops genuinely must be written twice. It failed on enforcement. Without one
normalised type, the allowlist check and the approval check get implemented twice, and the second
implementation is the one that drifts. **The adapter's justification is constraint enforcement,
not code reuse.**

Two consequences to carry into A1's brief:

- **Author tool schemas to the Gemini OpenAPI subset**, the narrower of the two — Gemini accepts
  "only a subset of the OpenAPI schema" and warns it may reject large or deeply nested schemas in
  `ANY` mode. Worth pinning with a test asserting each declared schema stays inside the flat
  subset.
- **Disable parallel tool calling on the voice path.** Name-based correlation cannot disambiguate
  two concurrent calls to the same Gemini function. *(The docs establish the correlation fields;
  the conclusion is the researcher's inference, labelled as such there.)*

**Unverified and carried forward:** Gemini's exact wire field names for function calling. The
guide page and the REST reference rendered in noticeably different shapes and the researcher could
not reconcile them. The load-bearing conclusions above (args-is-an-object, name-based correlation,
OpenAPI subset, Live is manual) hold under either rendering, but the literal field names are
**verify-at-implementation**.

## One code-level consequence

`AnthropicLlm.complete` catches every error and degrades to template text
(`agent/src/host/llm.ts:95` — verified: "ANY failure (timeout, API error, network) degrades to the
template — never throw"). That is correct
for a weekly report, which must always generate something. Carried into a tool-calling client it
would make **an API failure indistinguishable from a model choosing not to call a tool** — a silent
no-op in the action path.

The tool-calling client must **throw**. Degradation is a decision the caller makes explicitly, and
in the action path a degraded condition reaches a human. Worth a claim-pinning test.

## Consequences

- A1 builds a `ToolCallingLlmClient` alongside the existing `LlmClient` — **not** a widening of
  `LlmClient`, which serves the report path and should not grow a tool surface it never uses
  (`agent/src/host/llm.ts:3-5` defines the current one-method interface).
- The durable pause happens **between** the proposal and the execution — in a Postgres row, not
  mid-graph. There is no long-lived in-flight agent state to checkpoint, which is why the
  framework's core value proposition targets a problem this architecture does not have.
  *(Research's inference from the plan's shape, labelled as such there; this ADR adopts it.)*
- No LangGraph adapter is built "for the hiring signal." It would either sit unused — dead code
  this repo's discipline forbids — or become a second, weaker path to execution. The portability
  artifact that *does* get built is the `ToolCall` seam above, which earns its place by enforcing a
  constraint.
