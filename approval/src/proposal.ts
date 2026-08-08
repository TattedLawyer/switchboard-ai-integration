// Phase 3 / A1 — the proposal object, and the only grammar the door speaks.
//
// This is the load-bearing difference between "the agent has a writable pool" and "the
// agent has a credential to a door that writes on its behalf". A pool speaks SQL: rewrite
// the mart, forge an approval, forge an audit row, or `grant insert ... to
// switchboard_agent` and retire the differentiator itself. The door speaks ONE row shape.
// That difference is the entire claim, so this schema is the thing defending it — not a
// convenience validator.
//
// Two consequences follow and both are deliberate:
//   · `.strict()` — an unknown field is a REFUSAL, not a silently dropped one. A dropped
//     field is a proposal the human approved and the executor never saw.
//   · no `tenant_id` — the tenant is the deployment's (SEC-C1: one deployment serves one
//     configured tenant). A caller-supplied tenant would turn the agent's bearer token
//     into authority over every tenant on the host.
import { z } from "zod";

/**
 * The actions an agent may propose. An allowlist, and enforcement rather than
 * documentation — the same move `registerReadOnlyTool` makes for the MCP tool surface.
 * Growing it is a deliberate edit with its own review, never an accident of a payload.
 *
 * `send_email` is the only member today because C5 (send) is the first real outbound
 * action Phase 3 commits to, and an allowlist populated ahead of its executors would be
 * a list of things nobody is watching.
 */
export const PROPOSAL_ACTION_TYPES = ["send_email"] as const;
export type ProposalActionType = (typeof PROPOSAL_ACTION_TYPES)[number];

export const proposalSchema = z
  .object({
    // Bounded because it lands in a unique index; unbounded caller-controlled text in an
    // index is a cheap way to make inserts expensive.
    idempotency_key: z.string().min(1).max(200),
    action_type: z.enum(PROPOSAL_ACTION_TYPES),
    // An object, never a string, never null: the door stores jsonb and must not coerce.
    payload: z.record(z.string(), z.unknown()),
    // Required. A proposal a human cannot judge is not a proposal — it is an instruction
    // wearing a proposal's clothes, and constraint #1 asks a human to decide.
    rationale: z.string().min(1).max(4000),
  })
  .strict();

export type Proposal = z.infer<typeof proposalSchema>;

export interface ProposalRejection {
  ok: false;
  /** Field-level detail, safe to return: it describes the caller's own input. */
  errors: { path: string; message: string }[];
}
export type ProposalParse = { ok: true; value: Proposal } | ProposalRejection;

export function parseProposal(input: unknown): ProposalParse {
  const res = proposalSchema.safeParse(input);
  if (res.success) return { ok: true, value: res.data };
  return {
    ok: false,
    errors: res.error.issues.map((i) => ({
      path: i.path.join(".") || "(root)",
      message: i.message,
    })),
  };
}
