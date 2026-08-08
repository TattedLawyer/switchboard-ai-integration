// Phase 3 / A1 — the approval service's boot-time configuration.
//
// FAIL CLOSED, in the shape ingest/src/hmac.ts:30-42 established for this repo: one
// aggregated throw naming every missing variable, so an operator fixes the deploy once
// instead of discovering variables one crash at a time. ALLOW_DEV_SECRETS=1 is the only
// opt-out and it covers secrets ONLY — never the database URL, because pointing a service
// at a guessed database is not a dev convenience, it is a wrong answer that boots.

export function devSecretsAllowed(): boolean {
  return process.env.ALLOW_DEV_SECRETS === "1";
}

/** The published local-demo token. Same class as demo-secret-<source>: it lives in a
 *  public repo, so it is only ever reachable behind the explicit opt-in. */
export const DEV_PROPOSAL_TOKEN = "demo-proposal-token";

/**
 * The bearer secret the agent presents at the proposal door.
 *
 * A single shared secret rather than ingest's per-source HMAC: ingest's scheme is built
 * for unsolicited vendor pushes, and its ±300s timestamp window exists to bound replay of
 * captured requests. The proposal already carries an idempotency key that the database
 * enforces as unique, so that machinery would be redundant ceremony around one internal
 * caller. (`ingest/src/hmac.ts:12-14` types its parameter as `Source` precisely so a
 * secret cannot be derived for something that is not a source — a proposal is not one.)
 */
export function proposalToken(): string {
  const explicit = process.env.AGENT_PROPOSAL_TOKEN;
  if (explicit) return explicit;
  if (devSecretsAllowed()) return DEV_PROPOSAL_TOKEN;
  throw new Error(
    "AGENT_PROPOSAL_TOKEN is not set — refusing to fall back to the published demo " +
      "token. Set AGENT_PROPOSAL_TOKEN, or set ALLOW_DEV_SECRETS=1 for local demo use only.",
  );
}

/**
 * The approval service's OWN credential — required, never derived.
 *
 * Deriving it from DATABASE_URL would hand this service the migration owner's role: the
 * one role able to run `grant insert on ... to switchboard_agent`, i.e. able to DELETE the
 * published differentiator rather than defeat it. It must be `switchboard_approval`
 * (migration 014), and the startup check in main.ts refuses any other `current_user`.
 */
export function approvalConnectionString(): string {
  const url = process.env.APPROVAL_DATABASE_URL;
  if (url) return url;
  throw new Error(
    "APPROVAL_DATABASE_URL is required — the approval service connects as " +
      "switchboard_approval (migration 014) and will not derive a credential from " +
      "DATABASE_URL, which is the migration owner and can re-grant privileges.",
  );
}

/**
 * FLOOD CONTROL. A compromised agent host holds the door's bearer secret and can forge
 * well-formed proposals at volume. The terminal state of that is an approval queue no
 * human can triage, which DISABLES the "nothing acts without an identified approver"
 * constraint rather than merely annoying it. So the door counts pending rows and refuses
 * loudly at the cap. Range-checked in the idiom ingest applies to BACKFILL_INTERVAL_MS:
 * a non-integer or out-of-range value is a boot refusal naming the variable, never a
 * silent NaN that disables the cap.
 */
export const DEFAULT_PENDING_PROPOSAL_CAP = 100;

export function pendingCap(): number {
  const raw = process.env.PENDING_PROPOSAL_CAP;
  if (raw === undefined || raw === "") return DEFAULT_PENDING_PROPOSAL_CAP;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(
      `invalid PENDING_PROPOSAL_CAP "${raw}": must be an integer >= 1 ` +
        `(unset it for the default of ${DEFAULT_PENDING_PROPOSAL_CAP}).`,
    );
  }
  return n;
}

/**
 * Loopback by default. The proposal door's caller is a process on the same host in every
 * deployment shape this repo supports, and MCP's own local-server guidance is to restrict
 * a local door's reachability rather than rely on the token alone. An operator who really
 * does split the hosts says so explicitly.
 */
export function bindHost(): string {
  return process.env.APPROVAL_BIND_HOST ?? "127.0.0.1";
}

/** One aggregated boot assertion. Named variables, one throw, before anything listens. */
export function assertApprovalConfig(): void {
  const missing: string[] = [];
  if (!process.env.APPROVAL_DATABASE_URL) missing.push("APPROVAL_DATABASE_URL");
  if (!process.env.AGENT_PROPOSAL_TOKEN && !devSecretsAllowed()) {
    missing.push("AGENT_PROPOSAL_TOKEN");
  }
  if (missing.length > 0) {
    throw new Error(
      `approval service: missing required configuration: ${missing.join(", ")} — set them` +
        `${missing.includes("AGENT_PROPOSAL_TOKEN") ? ", or set ALLOW_DEV_SECRETS=1 for local demo use only" : ""}.`,
    );
  }
  pendingCap(); // range-check now, at boot, not on the first proposal
}
