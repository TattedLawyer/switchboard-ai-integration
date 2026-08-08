// Phase 3 / A1 — the agent host's client for the proposal door.
//
// 🚨 THIS MODULE MUST NEVER IMPORT `pg` OR CONTAIN SQL. That is the decision, not a style
// rule. The agent process holds exactly one database credential — the read-only
// `switchboard_agent` role — and acquiring a second, write-capable one here would
// permanently destroy the property the README publishes, in a way no later configuration
// could undo. When the agent proposes an action it returns a typed object; the approval
// service validates it and records it. `agent/test/writer-boundary.test.ts` sweeps
// `agent/src/**` and reds if this file (or any sibling) grows a pool or a credential.
//
// The authority this client holds is therefore: *append one schema-validated, human-gated
// proposal*. Not arbitrary SQL. That difference is the entire claim.
//
// Honest limit, stated here because it qualifies a published sentence: on a single-box
// self-hosted deployment the agent host and the approval service very likely run as the
// same OS user, so an attacker with code execution here can read the approval service's
// configuration and recover its credential directly. This is CREDENTIAL LOCALITY, NOT OS
// SANDBOXING. It is recorded in KNOWN-ISSUES as an accepted disclosure.

export interface ProposalInput {
  /** Stable across retries of the SAME logical proposal — the door's unique index turns a
   *  replay into a no-op returning the original id. */
  idempotencyKey: string;
  actionType: string;
  payload: Record<string, unknown>;
  /** Why a human should say yes. Required by the door; a proposal a human cannot judge is
   *  an instruction wearing a proposal's clothes. */
  rationale: string;
}

export interface RecordedProposal {
  id: string;
  state: string;
  /** True when the door recognised this idempotency key and returned the original row. */
  duplicate: boolean;
}

/**
 * The door's address. Required, fail-closed: a default would make "the approval service is
 * not running" indistinguishable from "the operator forgot", and the second is a
 * deployment defect that should refuse rather than retry against localhost forever.
 */
export function approvalBaseUrl(): string {
  const url = process.env.APPROVAL_BASE_URL;
  if (url) return url.replace(/\/+$/, "");
  throw new Error(
    "APPROVAL_BASE_URL is required — the agent does not write proposals itself; it posts " +
      "them to the approval service (dev: http://127.0.0.1:4009).",
  );
}

/** The bearer secret for the door, in the same fail-closed family as the webhook secrets.
 *  Note what this credential is and is not: it authenticates ONE narrow append, and it is
 *  not a database credential. */
export function proposalToken(): string {
  const explicit = process.env.AGENT_PROPOSAL_TOKEN;
  if (explicit) return explicit;
  if (process.env.ALLOW_DEV_SECRETS === "1") return "demo-proposal-token";
  throw new Error(
    "AGENT_PROPOSAL_TOKEN is not set — refusing to fall back to the published demo token. " +
      "Set AGENT_PROPOSAL_TOKEN, or set ALLOW_DEV_SECRETS=1 for local demo use only.",
  );
}

/** Raised when the door did not record the proposal. Carries the status so a caller can
 *  tell "the door refused this proposal" (4xx) from "the door was unreachable" (5xx/network). */
export class ProposalNotRecordedError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly detail: unknown,
  ) {
    super(message);
    this.name = "ProposalNotRecordedError";
  }
}

/**
 * Hands one proposal across the boundary.
 *
 * LOUD ON FAILURE, ALWAYS. The agent's proposal path now depends on the approval service
 * being up — a real new failure mode, and the governing precedent for how to treat it is
 * this repo's own `AnthropicLlm.complete`, which swallows every error and returns template
 * text. That is tolerable in a narrative; in an action path a failure must STOP rather than
 * produce a plausible-looking result. So there is no retry-until-success, no fallback
 * value, and no "recorded locally" story: an unrecorded proposal throws.
 */
export async function recordProposal(
  input: ProposalInput,
  opts: { baseUrl?: string; token?: string; fetchImpl?: typeof fetch } = {},
): Promise<RecordedProposal> {
  const baseUrl = opts.baseUrl ?? approvalBaseUrl();
  const token = opts.token ?? proposalToken();
  const doFetch = opts.fetchImpl ?? fetch;

  // Field names are the door's wire shape (snake_case). The door is the AUTHORITY on
  // whether a proposal is well-formed — deliberately not re-implemented here, because two
  // validators drift and the one that matters is the one in front of the INSERT.
  const wire = {
    idempotency_key: input.idempotencyKey,
    action_type: input.actionType,
    payload: input.payload,
    rationale: input.rationale,
  };

  let res: Response;
  try {
    res = await doFetch(`${baseUrl}/internal/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(wire),
    });
  } catch (err) {
    throw new ProposalNotRecordedError(
      `proposal was NOT recorded: the approval service at ${baseUrl} is unreachable`,
      null,
      err instanceof Error ? err.message : String(err),
    );
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (res.status !== 200 && res.status !== 201) {
    throw new ProposalNotRecordedError(
      `proposal was NOT recorded: the approval door answered ${res.status}`,
      res.status,
      body,
    );
  }

  const recorded = body as { id?: unknown; state?: unknown; duplicate?: unknown };
  if (typeof recorded.id !== "string" || typeof recorded.state !== "string") {
    // A 2xx with no id is not a success. Refusing to invent one is the difference between
    // "we do not know whether this was recorded" and a caller believing it was.
    throw new ProposalNotRecordedError(
      "proposal was NOT recorded: the approval door answered 2xx without an id",
      res.status,
      body,
    );
  }
  return { id: recorded.id, state: recorded.state, duplicate: recorded.duplicate === true };
}
