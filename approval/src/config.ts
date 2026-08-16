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

/**
 * A0b — the HUMAN surface's configuration. Opt-in, explicit, and fail-closed.
 *
 * `APPROVAL_HUMAN_SURFACE=1` is what registers `/login`, `/queue` and `/decide` at all.
 * Absent, the service is the agent-door-only deployment that shipped with A1, byte for
 * byte. When present, the surface demands a session secret and a public base URL at BOOT
 * — a login page that cannot mint a valid link, or a session cookie signed with an
 * accidental default, is a deployment mistake that must refuse to listen rather than
 * half-work.
 */
export function humanSurfaceEnabled(): boolean {
  return process.env.APPROVAL_HUMAN_SURFACE === "1";
}

/** Same class as DEV_PROPOSAL_TOKEN: published, so reachable only behind the explicit
 *  ALLOW_DEV_SECRETS opt-in. */
export const DEV_SESSION_SECRET = "demo-session-secret";

/** Signs the session cookie. Required whenever the human surface is enabled. */
export function sessionSecret(): string {
  const explicit = process.env.APPROVAL_SESSION_SECRET;
  if (explicit) return explicit;
  if (devSecretsAllowed()) return DEV_SESSION_SECRET;
  throw new Error(
    "APPROVAL_SESSION_SECRET is not set — refusing to sign session cookies with a " +
      "published fallback. Set APPROVAL_SESSION_SECRET, or set ALLOW_DEV_SECRETS=1 for " +
      "local demo use only.",
  );
}

/**
 * The origin the APPROVER'S BROWSER uses — the base every magic link is minted under.
 * Distinct from APPROVAL_BASE_URL, which is where the AGENT posts proposals: on a real
 * deployment the human reaches a TLS hostname while the agent posts loopback, and
 * conflating the two would bake a loopback address into her sign-in email.
 */
export function approvalPublicUrl(): string {
  const raw = process.env.APPROVAL_PUBLIC_URL;
  if (!raw) {
    throw new Error(
      "APPROVAL_PUBLIC_URL is required when APPROVAL_HUMAN_SURFACE=1 — it is the origin " +
        "the approver's browser uses, and every magic link is minted under it. No default " +
        "on purpose: a guessed origin makes sign-in links that point somewhere nobody serves.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid APPROVAL_PUBLIC_URL "${raw}": must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`invalid APPROVAL_PUBLIC_URL "${raw}": must be http or https`);
  }
  return raw.replace(/\/+$/, "");
}

/**
 * THE DOCUMENTED DEV PATH for the session cookie, and the only one.
 *
 * The production cookie is `__Host-`-prefixed and Secure — non-negotiable, because the
 * prefix is what makes the cookie unsettable by a sibling subdomain or a non-secure
 * origin. But a `__Host-` cookie DOES NOT EXIST over plain http on a LAN address
 * (browsers refuse to store it; localhost is exempted by Chrome and Firefox, historically
 * not by Safari), and express-session itself refuses to SET a `secure: true` cookie on a
 * non-TLS connection. So local http development needs an explicit, loud opt-out:
 * `APPROVAL_COOKIE_INSECURE=1` renames the cookie (the `__Host-` prefix would be a lie
 * without Secure) and drops the Secure attribute. It is banner-logged at boot, and it is a
 * SEPARATE switch from ALLOW_DEV_SECRETS because weakening transport is not a secrets
 * question and must be chosen on its own.
 */
export function cookieInsecureDev(): boolean {
  return process.env.APPROVAL_COOKIE_INSECURE === "1";
}

/**
 * MAGIC-LINK PARAMETERS. All three are JUDGMENT with no source, surfaced here in the
 * PROPOSAL_TTL_HOURS idiom rather than buried as unexplained constants.
 *
 * · 15 minutes: long enough to walk from "Send me a link" to an inbox, short enough that
 *   a link lying in a mailbox is stale before most humans would re-find it. The ADR's
 *   mitigation shape is "short expiry, single use"; the numeral is ours.
 * · 5 requests per hour per ACCOUNT: bounds what a stranger who knows the approver's
 *   email can make us send her, and what a bug can burn through the relay. Per-account
 *   rather than per-IP because this surface sits behind loopback or one operator's
 *   reverse proxy, where source addresses collapse.
 * · 7 days rolling: the session decision recorded in the A0b brief — a rolling window,
 *   not remember-me machinery.
 */
export const LOGIN_TOKEN_TTL_MINUTES = 15;
export const LOGIN_REQUEST_RATE_LIMIT = 5;
export const LOGIN_REQUEST_WINDOW_MINUTES = 60;
export const SESSION_TTL_DAYS = 7;

/** One aggregated boot assertion. Named variables, one throw, before anything listens. */
export function assertApprovalConfig(): void {
  const missing: string[] = [];
  if (!process.env.APPROVAL_DATABASE_URL) missing.push("APPROVAL_DATABASE_URL");
  if (!process.env.AGENT_PROPOSAL_TOKEN && !devSecretsAllowed()) {
    missing.push("AGENT_PROPOSAL_TOKEN");
  }
  if (humanSurfaceEnabled()) {
    if (!process.env.APPROVAL_SESSION_SECRET && !devSecretsAllowed()) {
      missing.push("APPROVAL_SESSION_SECRET");
    }
    if (!process.env.APPROVAL_PUBLIC_URL) missing.push("APPROVAL_PUBLIC_URL");
  }
  if (missing.length > 0) {
    throw new Error(
      `approval service: missing required configuration: ${missing.join(", ")} — set them` +
        `${missing.some((m) => m === "AGENT_PROPOSAL_TOKEN" || m === "APPROVAL_SESSION_SECRET") ? ", or set ALLOW_DEV_SECRETS=1 for local demo use only" : ""}.`,
    );
  }
  pendingCap(); // range-check now, at boot, not on the first proposal
  actionRateLimit(); // same: a bad rate limit is a boot refusal, never a silent NaN
  if (humanSurfaceEnabled()) approvalPublicUrl(); // malformed URL is a boot refusal too
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
 * decision, with no re-proposal path inside A2 (that is A5's). 🚨 A0b HAS NOW SHIPPED
 * LOGIN AND A5 HAS NOT SHIPPED RE-PROPOSAL, so this is a LIVE cost, not a latent one:
 * a real person's approval can now age out unexecuted. KNOWN-ISSUES carries it.
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
