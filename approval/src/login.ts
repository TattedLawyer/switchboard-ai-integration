// A0b — magic-link login: issuing, consuming, and auditing the one credential this
// surface has.
//
// THE SHAPE, from `docs/adr/approver-identity.md`: the client signs in through a one-time
// link sent to her own mailbox. No password storage, no reset flow. The ADR's stated
// caveat — "a magic link is a bearer token in an inbox" — is the design driver for every
// property below:
//
//   · CSPRNG tokens (256 bits, `crypto.randomBytes`), never derived from anything;
//   · HASHED AT REST — the table stores SHA-256(token), so nothing readable from the
//     database (backup, replica, log) can be pasted into a browser;
//   · SINGLE-USE, enforced by an atomic conditional UPDATE in the decide.ts idiom: check
//     and consume are ONE statement, so two racing consumers cannot both win;
//   · SHORT EXPIRY (LOGIN_TOKEN_TTL_MINUTES) checked inside the same statement;
//   · RATE-LIMITED per account, so a stranger who knows her address cannot make us flood
//     her inbox, and a bug cannot burn the relay;
//   · ONE AUDIT ROW PER LOGIN — the ADR requires it in terms, "because these links
//     authorise outward actions".
//
// 🚨 EMAIL RESOLUTION IS EXACT BYTE EQUALITY, inheriting migration 015's warning in
// full: the unique index on `lower(email)` is storage hygiene and MUST NEVER become a
// comparison predicate — `lower()` is not identity-preserving for mailboxes (U+212A
// lower-cases to `k`, U+0130 collides with `i`) and RFC 5321 §2.3.11 makes the local part
// the mailbox owner's business. So the lookup below is `email = $1`, case-sensitive,
// byte-for-byte. The operational consequence is disclosed rather than smoothed: the
// address typed at login must match the address the operator seeded, exactly.
//
// 🚨 THE REQUEST PATH NEVER *SAYS* WHETHER AN ADDRESS EXISTS — and "says" is doing
// exact work in that sentence. What is uniform is the PAGE: an unknown address, a
// disabled user and a rate-limited account all earn the same 200 and the same bytes as a
// successful request, and the difference is observable in this module's return value
// only, which the route uses for LOGGING, never for the response body — a login page
// that answers differently for known addresses is an approver-list oracle. What is NOT
// uniform is TIMING, and response timing is outward behaviour too: an unknown address
// returns after one indexed SELECT, while an active under-limit approver's request
// awaits the real SMTP send (tens to hundreds of milliseconds through Postmark) before
// the route renders that same page. A caller timing POST /login/request can therefore
// distinguish a registered approver from a stranger. OWASP's authentication guidance
// asks for more than identical messages here — "avoid timing discrepancies between
// valid and invalid cases" — so this is a DISCLOSED DEVIATION, not an oversight. The
// two conforming shapes were weighed and declined, for now:
//   · RESPOND-BEFORE-SEND (deliver the link off the response path) makes the duration
//     independent of membership, but leaves a path where the link is never sent and the
//     only witness is a server log — while the page has already told the requester to
//     watch her inbox. Today a failed send earns HER a loud 503 (see the route in
//     human.ts); trading that away converts delivery failure into the
//     silence-that-reads-as-calm defect class this repo refuses. That trade decides it.
//   · EQUALISE THE WORK in both branches — the classic pattern (do a dummy comparison
//     when the user is absent). But the cost being hidden here is not a hash compare,
//     it is a variable third-party SMTP round trip, so the pad is a guessed upper bound
//     that leaks again whenever a real send exceeds it — and padding measured around
//     network I/O achieves less than it appears to
//     (adam-p.ca/blog/2021/11/constant-time-network/).
// Residual, stated plainly: what leaks is membership of the approver list, never a
// credential. Each probe of a real address costs that mailbox a visible sign-in mail
// until the per-account rate limit trips (after which the difference SHRINKS — the
// rate-limited path skips the SMTP wait but still pays two indexed reads to the unknown
// path's one — the limit complements this disclosure, it does not close the oracle).
// During a relay outage the leak is louder
// than timing: only resolved addresses reach the send, so a 503 then IS a membership
// signal, on the same disclosed terms. And the surface binds to loopback today.
// Revisit — respond-before-send plus real operator alerting for failed sends — before
// this page ever faces a network where strangers can time it.
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import {
  LOGIN_REQUEST_RATE_LIMIT,
  LOGIN_REQUEST_WINDOW_MINUTES,
  LOGIN_TOKEN_TTL_MINUTES,
} from "./config.js";

/** Delivers a minted sign-in link to one mailbox. The REAL implementation rides the
 *  Postmark SMTP transport (`crm/src/email-transport.ts`) and is wired at the composition
 *  root (`scripts/approval-service.ts`), because 69ad456 closed cross-workspace src
 *  imports and the composition root is the one thing that must cross. `main.ts` run bare
 *  has no sender and REFUSES to enable the surface unless ALLOW_DEV_SECRETS=1 supplies
 *  the console stub. */
export type SendLoginLink = (to: string, url: string) => Promise<void>;

export function hashLoginToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** 32 CSPRNG bytes, base64url — URL-safe without escaping, 43 chars. */
export function generateLoginToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What `requestLoginLink` did, FOR LOGGING ONLY. Never surfaced to the requester. */
export type LoginRequestOutcome =
  | { kind: "sent"; userId: string }
  | { kind: "unknown-address" }
  | { kind: "rate-limited"; userId: string };

/**
 * The request half: resolve the address, rate-limit the account, mint and store a token,
 * send the link. Every outcome returns; none throws for "no" — only infrastructure
 * failures (database down, sender failed) propagate, because those the caller must
 * surface loudly rather than absorb into the anti-enumeration silence.
 *
 * The token row is written BEFORE the send. The reverse order can send a link whose
 * token was never recorded (a mail that can never log in — silent, the worst kind); this
 * order can record a token whose mail never arrived, which costs one dead row and the
 * human clicks "send me a link" again.
 */
export async function requestLoginLink(
  pool: pg.Pool,
  email: string,
  publicUrl: string,
  send: SendLoginLink,
): Promise<LoginRequestOutcome> {
  // Exact byte equality — see the header. `disabled_at is null` makes a disabled approver
  // indistinguishable from an unknown address, which is the correct amount of information.
  const user = await pool.query<{ id: string }>(
    `select id from approval.users where email = $1 and disabled_at is null`,
    [email],
  );
  if (user.rowCount !== 1) return { kind: "unknown-address" };
  const userId = user.rows[0].id;

  const recent = await pool.query<{ n: number }>(
    `select count(*)::int as n from approval_auth.login_tokens
      where user_id = $1 and created_at > now() - make_interval(mins => $2::int)`,
    [userId, LOGIN_REQUEST_WINDOW_MINUTES],
  );
  if (recent.rows[0].n >= LOGIN_REQUEST_RATE_LIMIT) {
    return { kind: "rate-limited", userId };
  }

  const raw = generateLoginToken();
  await pool.query(
    `insert into approval_auth.login_tokens (user_id, token_hash, expires_at)
     values ($1, $2, now() + make_interval(mins => $3::int))`,
    [userId, hashLoginToken(raw), LOGIN_TOKEN_TTL_MINUTES],
  );

  await send(email, `${publicUrl}/login/consume?token=${raw}`);
  return { kind: "sent", userId };
}

export interface ConsumedLogin {
  userId: string;
  tokenId: string;
}

/**
 * The consume half: one atomic compare-and-set. Expired, already-used, tampered and
 * unknown tokens all take the same path — zero rows updated, `null` returned — and the
 * route answers all of them with one undifferentiated refusal, for the same
 * anti-enumeration reason as the request half.
 *
 * The `disabled_at` check is INSIDE the statement: a link minted while the user was
 * active must die the moment an operator disables her, not survive as a 15-minute
 * grace period.
 */
export async function consumeLoginToken(
  pool: pg.Pool,
  raw: string,
): Promise<ConsumedLogin | null> {
  const res = await pool.query<{ id: string; user_id: string }>(
    `update approval_auth.login_tokens t
        set used_at = now()
      where t.token_hash = $1
        and t.used_at is null
        and t.expires_at > now()
        and exists (select 1 from approval.users u
                     where u.id = t.user_id and u.disabled_at is null)
      returning t.id, t.user_id`,
    [hashLoginToken(raw)],
  );
  if (res.rowCount !== 1) return null;
  return { userId: res.rows[0].user_id, tokenId: res.rows[0].id };
}

/** One row per login, append-only (migration 019 grants no UPDATE or DELETE on it). */
export async function recordLogin(pool: pg.Pool, login: ConsumedLogin): Promise<void> {
  await pool.query(
    `insert into approval_auth.login_audit (user_id, token_id) values ($1, $2)`,
    [login.userId, login.tokenId],
  );
}
