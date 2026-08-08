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
 * FLOOD CONTROL — 🚨 A RUNAWAY BACKSTOP, NOT AN ATTENTION BUDGET, and the WEAKEST of the
 * three volume controls on this door.
 *
 * It bounds what a compromised agent host can leave sitting in the queue: such a host
 * holds the bearer secret and can forge well-formed proposals at volume, and the terminal
 * state of that is a queue no human can triage — which DISABLES the "nothing acts without
 * an identified approver" constraint rather than merely annoying it.
 *
 * 🚨 NO PUBLISHED SOURCE GIVES A NUMBER FOR THIS. Neither 100 nor any other value here is
 * derived from evidence about human attention; nobody has measured the quantity this
 * number would have to be about. What actually protects approval QUALITY is, in ranked
 * order: repeat-suppression and the one-proposal-one-outcome discipline (STRONGEST —
 * Ancker measured it, and repeat-suppression is the authors' own recommended lever), then
 * the per-action rate limit, then expiry. This count is fourth.
 *
 * 🚨 AND THE NUMERAL IS UNCHANGED WHILE THE QUANTITY IS NOT. Since A2 the door counts
 * UNEXPIRED pending rows, not all pending rows — a different quantity under the same
 * number. That filter is what makes one dead burst stop holding budget forever, and it is
 * duplicated in the door rather than centralised in the sweeper on purpose: it must heal
 * the queue with no process running at all.
 *
 * Range-checked in the idiom ingest applies to BACKFILL_INTERVAL_MS: a non-integer or
 * out-of-range value is a boot refusal naming the variable, never a silent NaN that
 * disables the cap.
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
  actionRateLimit(); // same: a bad rate limit is a boot refusal, never a silent NaN
}

/**
 * HOW LONG AN ASK STAYS ASKABLE. 72 hours.
 *
 * 🚨 JUDGMENT, WITH NO SOURCE. No published work gives a number for this, and this one is
 * not derived from evidence about anything. It is surfaced as owner decision R5 rather
 * than left as an unexplained constant, because the first revision of this design failed
 * in exactly that way: an unsourced number in a place nobody greps.
 *
 * SCOPE: A5 owns TTL *values* and may revise this. A2 owns it only because the door has to
 * write `expires_at` at insert, so A2 must pick a number it does not own.
 *
 * KEEP IN SYNC with migration 015's backfill (`created_at + interval '72 hours'`), which
 * is what a row predating A2 gets. The two are pinned together by
 * `approval/test/door-idempotency.test.ts` ("a 72-hour expiry") and
 * `ingest/test/migration-015-proposals.test.ts`.
 *
 * WHAT THE NUMBER OPERATIONALLY MEANS, said plainly rather than buried: an APPROVED row
 * that is not executed within it becomes `expired`, which is terminal — a destroyed human
 * decision, with no re-proposal path inside A2 (that is A5's). Harmless today because
 * nobody can approve until A0b ships login. Unsafe the day A0b lands without A5.
 */
export const PROPOSAL_TTL_HOURS = 72;

/**
 * The states from which nothing further happens. A proposal in one of these is DISPOSED
 * OF: it is not queued, no card renders for it, and no execution will follow.
 *
 * The door needs this set because `proposals_idempotency_unique` is permanent and
 * STATE-BLIND. Without it, a re-proposal under a key whose row has expired unread is
 * answered as though the ask were still queued.
 *
 * `pending`, `approved` and `executing` are deliberately absent: each is a live row with
 * something still to happen to it.
 */
export const TERMINAL_PROPOSAL_STATES: ReadonlySet<string> = new Set([
  "rejected",
  "expired",
  "superseded",
  "executed",
  "execution_failed",
]);

/**
 * PER-ACTION RATE LIMIT — a runaway backstop, ranked THIRD.
 *
 * The ranking matters more than the numbers, and it is the one part of this that has
 * evidence behind it: repeat-suppression / the 1:1 discipline is STRONGEST (Ancker
 * measured it and it is the authors' own recommended lever; SRE's 1:1 alert/incident
 * ratio; OWASP's bind-approval-to-the-exact-action), then the rate limit, then expiry,
 * then the static count — WEAKEST, because no source uses one, recommends one, or gives a
 * value for one.
 *
 * 🚨 THE NUMBERS HERE ARE JUDGMENT AND HAVE NO SOURCE. SRE's "maximum 2 per 12-hour
 * on-call shift" is a rate DERIVED FROM HANDLING TIME; the METHOD transfers and the NUMBER
 * does not, because nobody has measured how long a broker spends on one of these. 20 per
 * action type per hour is a bound on how fast a compromised agent host can fill her queue,
 * not a claim about her attention.
 */
export const DEFAULT_ACTION_RATE_LIMIT = 20;
export const ACTION_RATE_WINDOW_MINUTES = 60;

export function actionRateLimit(): number {
  const raw = process.env.PROPOSAL_ACTION_RATE_LIMIT;
  if (raw === undefined || raw === "") return DEFAULT_ACTION_RATE_LIMIT;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(
      `invalid PROPOSAL_ACTION_RATE_LIMIT "${raw}": must be an integer >= 1 ` +
        `(unset it for the default of ${DEFAULT_ACTION_RATE_LIMIT}).`,
    );
  }
  return n;
}
