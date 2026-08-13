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
 * `send_email` arrived first because C5 (send) is the first real outbound action Phase 3
 * commits to, and an allowlist populated ahead of its executors would be a list of things
 * nobody is watching. `place_call` joins it with the core follow-up loop (T8), which ships
 * its executor in the same wave.
 */
export const PROPOSAL_ACTION_TYPES = ["send_email", "place_call"] as const;
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

// ---------------------------------------------------------------------------------------
// PAYLOAD GRAMMARS — core follow-up loop, T8.
// ---------------------------------------------------------------------------------------
//
// The door itself stores `payload` as an opaque object, deliberately: it is the approval
// spine, not the CRM. These schemas are what the PROPOSER validates against before it
// posts, and what the EXECUTOR validates on the way back out — so a payload that would not
// produce a call is refused before a human is asked to judge it.
//
// `.strict()` on both, for the reason the file header already gives: an unknown field is a
// REFUSAL, not a silently dropped one, and a dropped field is a proposal the human approved
// and the executor never saw.

/**
 * A single outbound call.
 *
 * 🚨 `display_name` IS EXPLICITLY NULLABLE, and this is the cheapest way this design could
 * have died silently. The owner's decision (rev 4) is that a number with NO NAME still gets
 * called — the agent introduces itself as an associate of the broker. An implementer
 * writing `z.string()` next to a `.strict()` schema would make EVERY NAMELESS PROPOSAL FAIL
 * VALIDATION: the decision dead on arrival, with nothing in the suite noticing. The contact
 * column is nullable too, so every condition in this design is `display_name is null`,
 * never `= ''`.
 *
 * 🚨 EXACTLY ONE `phone_e164`, never an array. That is §5.1's rule at the schema level: an
 * approved proposal names ONE number in an immutable payload, so dialling a second
 * mid-execution would place a call to a number the human never approved — falsifying the
 * claim README.md publishes. The list rotates ACROSS cycles, not within one.
 *
 * 🚨 `opening_line` IS FULLY RENDERED, not a template. She approves the exact words that
 * will be spoken, and 015:353-363 then makes them unchangeable. Nothing is substituted at
 * call time, so a rendered line must carry no `{name}` placeholder.
 *
 * 🚨 `question_set_id` IS REQUIRED. A call not bound to a question VERSION is
 * unreproducible: nothing afterwards can say what the prospect was actually asked.
 */
export const placeCallPayloadSchema = z
  .object({
    contact_id: z.string().uuid(),
    phone_number_id: z.string().uuid(),
    phone_e164: z.string().min(1),
    display_name: z.string().nullable(),
    opening_line: z.string().min(1),
    question_set_id: z.string().uuid(),
    context: z
      .object({
        source_detail: z.string().nullable(),
        looking_for: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export type PlaceCallPayload = z.infer<typeof placeCallPayloadSchema>;

/** The follow-up email. Single message only — no sequences (owner).
 *
 *  🚨 EVERY RULE HERE IS A CHECK. NOTHING TRANSFORMS. No `.trim()`, no `.toLowerCase()`,
 *  no `.transform()`, no coercion — here or anywhere else on the send path. `parsePayload`
 *  must return the recipient that is STORED in `approval.proposals.payload`, COVERED by
 *  `payload_hash`, and RENDERED on the card the human approved. One character of divergence
 *  dissolves that identity silently: a trailing space renders visibly on the card and
 *  vanishes in the envelope, and the approved-equals-sent property — which the whole
 *  approval design rests on — becomes unfalsifiable.
 *
 *  This would be the first schema in the repo to mutate an approved payload on its way to a
 *  side effect. Refusing is recoverable; normalising is not. So whitespace is REFUSED, not
 *  stripped, and the comma refusal closes the multi-recipient string that `.email()` alone
 *  would let through in some forms. */
export const followUpEmailPayloadSchema = z
  .object({
    contact_id: z.string().uuid(),
    to: z
      .string()
      .min(3)
      .max(254)
      .email()
      .refine((v) => !v.includes(","), { message: "one recipient only" })
      .refine((v) => v === v.trim(), { message: "leading/trailing whitespace" }),
    subject: z.string().min(1),
    body: z.string().min(1),
  })
  .strict();

export type FollowUpEmailPayload = z.infer<typeof followUpEmailPayloadSchema>;
