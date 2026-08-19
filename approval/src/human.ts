// A0b — the human decision surface, now with an identified human.
//
// WHAT THIS IS. `/login`, `/queue` and `/decide`: magic-link sign-in, a server-side
// session, and the approval page. The approver id on every decision row comes from the
// SESSION — the person who completed a sign-in link sent to her own mailbox — never from
// configuration. `APPROVAL_OPERATOR_USER_ID` is gone; a deployment cannot attribute
// decisions to a configured constant any more, because that option no longer exists.
//
// WHY NOW. The previous revision of this file ran with no login and no CSRF defence and
// said so, listing three conditions under which that was acceptable: a scratch database,
// loopback binding, and no real transport. Two of the three are already false — the
// system sends real mail through Postmark and reconciles real bounces — and the header's
// own rule was that ANY one changing is the trigger for real auth. This file is that
// trigger being obeyed.
//
// THE DEFENCES, and what each one is for:
//   · SESSION — `express-session` over `connect-pg-simple`, store table created by
//     migration 019 (`createTableIfMissing: false`: the role cannot CREATE, measured, and
//     a table minted outside the checksum-pinned migration ledger is the defect class
//     this repo refuses). Cookie is `__Host-`-prefixed, Secure, HttpOnly, SameSite=Lax,
//     rolling ~7 days. The session id is REGENERATED at login, so a pre-login sid fixed
//     into a browser never becomes an authenticated one.
//   · CSRF, twice, on every state-changing route. A synchronizer token (`csrf-sync`)
//     carried in the form and compared against the session; AND a Fetch-Metadata check —
//     `Sec-Fetch-Site` must be same-origin (or `none`), with the Origin header as the
//     fallback for agents that send no Fetch-Metadata, and a REFUSAL when both are
//     absent. Two mechanisms because they fail differently: the token dies with a leaked
//     form; the header check dies with a non-conforming client — and both dying at once
//     is the coincidence an attacker does not get to schedule.
//   · MAGIC-LINK LOGIN — see `login.ts`: CSPRNG tokens hashed at rest, single-use by
//     atomic compare-and-set, 15-minute expiry, per-account rate limit, one append-only
//     audit row per login. The emailed link lands on a GET that CONSUMES NOTHING (mailbox
//     scanners prefetch GETs); the consume is a POST behind the same CSRF pair as
//     everything else.
//
// WHAT THIS DOES NOT CLAIM. Anyone with access to the approver's MAILBOX can become her
// here — that is the ADR's disclosed shape of magic-link auth, not a defect this file
// hides. And none of this changes where safety rests (the read-only credential and the
// immutability trigger); it changes whether the audit row's name means a person.
//
// WHY `approveCard`/`rejectCard` AND NOT `decideOn`. Two separate reasons, both load-bearing:
//   · The 015 trigger requires the decision row and the state change in the SAME transaction.
//     `decideOn` deliberately opens none. Calling it on a bare pool client makes `dismissed`
//     autocommit its insert BEFORE the liveness check — a fabricated decision row that no
//     rollback removes.
//   · A decision must dispose of the byte-identical repeats behind its card, or they re-render
//     as a card the human already answered and approving that sends the same email twice.
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { csrfSync } from "csrf-sync";
import type pg from "pg";
import { readPendingQueue } from "./queue.js";
import { collapseDuplicates, approveCard, rejectCard, type CollapsedCard } from "./suppress.js";
import { renderProposalCard, escapeHtml } from "./render.js";
import { decide, DecisionRefused } from "./decide.js";
import {
  consumeLoginToken,
  recordLogin,
  requestLoginLink,
  type SendLoginLink,
} from "./login.js";
import { SESSION_TTL_DAYS } from "./config.js";
import { registerKnowledgeRoutes } from "./knowledge.js";

declare module "express-session" {
  interface SessionData {
    /** Present exactly when a magic link was consumed in THIS session's lifetime. The
     *  approver id every decision is attributed to. */
    userId?: string;
    // `csrfToken` is declared by csrf-sync's own module augmentation.
  }
}

export interface HumanSurfaceOptions {
  tenantId: string;
  /** Signs the session cookie. From config, never a literal. */
  sessionSecret: string;
  /** true in every real deployment. false ONLY via the documented APPROVAL_COOKIE_INSECURE
   *  dev path — `__Host-`/Secure cookies do not exist over plain http on a LAN address,
   *  and express-session itself refuses to set a Secure cookie on a non-TLS connection. */
  cookieSecure: boolean;
  /** The browser-facing origin sign-in links are minted under. */
  publicUrl: string;
  /** Delivers the link. Real Postmark transport at the composition root; a stub in tests. */
  sendLoginLink: SendLoginLink;
  /** Test seam only: connect-pg-simple's prune interval (seconds), or false to disable. */
  pruneSessionIntervalSeconds?: number | false;
}

/** The production cookie, stated once and pinned by test: `__Host-` prefix (which is a
 *  lie without Secure, hence the renamed dev variant), Secure, HttpOnly, SameSite=Lax,
 *  Path=/ (the prefix requires it), rolling SESSION_TTL_DAYS. */
export function sessionCookieSettings(cookieSecure: boolean): {
  name: string;
  cookie: session.CookieOptions;
} {
  return {
    name: cookieSecure ? "__Host-approval.sid" : "approval.sid",
    cookie: {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    },
  };
}

function page(title: string, body: string): string {
  return (
    "<!doctype html><html><head><meta charset='utf-8'>" +
    `<title>${escapeHtml(title)}</title>` +
    // The rendered rationale is model-authored text. A restrictive CSP does not stop it
    // fooling a person — only the caption discipline in render.ts does that — but it caps
    // what any future escaping slip could reach.
    "<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; style-src 'unsafe-inline'\">" +
    "<style>body{font-family:system-ui;margin:2rem;max-width:46rem}" +
    "article{border:1px solid #999;padding:1rem;margin:1rem 0}" +
    ".rationale-caption{font-size:.8rem;color:#666}" +
    "textarea{width:100%}</style></head><body>" +
    body +
    "</body></html>"
  );
}

/**
 * The Fetch-Metadata half of the CSRF pair. Applied to every state-changing method.
 * Returns the reason for refusal, or null to allow.
 *
 * `Sec-Fetch-Site: same-origin` is the browser's own attestation of where the request
 * was initiated; `none` is a user-typed navigation. Everything else — `cross-site`,
 * `same-site` (a sibling subdomain is NOT this site) — is refused. Agents that send no
 * Fetch-Metadata fall back to the Origin header compared against Host; a request
 * carrying NEITHER is refused, because "no evidence of origin" must not be the cheapest
 * way to pass a check about origin.
 */
export function crossSiteRefusal(req: express.Request): string | null {
  const site = req.get("sec-fetch-site");
  if (site !== undefined) {
    return site === "same-origin" || site === "none" ? null : `Sec-Fetch-Site is "${site}"`;
  }
  const origin = req.get("origin");
  if (origin === undefined) {
    return "the request carries neither Sec-Fetch-Site nor Origin";
  }
  try {
    if (new URL(origin).host === req.get("host")) return null;
  } catch {
    /* fall through to refusal */
  }
  return `Origin "${origin}" is not this host`;
}

export function registerHumanRoutes(
  app: express.Express,
  pool: pg.Pool,
  opts: HumanSurfaceOptions,
): void {
  const form = express.urlencoded({ extended: false });

  const PgStore = connectPgSimple(session);
  const store = new PgStore({
    pool,
    schemaName: "approval_auth",
    tableName: "sessions",
    // Migration 019 creates the table; the role cannot, and must not — see the header.
    createTableIfMissing: false,
    ...(opts.pruneSessionIntervalSeconds !== undefined
      ? { pruneSessionInterval: opts.pruneSessionIntervalSeconds }
      : {}),
  });

  const cookieSettings = sessionCookieSettings(opts.cookieSecure);
  const sessionMw = session({
    store,
    name: cookieSettings.name,
    secret: opts.sessionSecret,
    resave: false,
    // No row for a visitor the surface never gave anything to remember.
    saveUninitialized: false,
    // The rolling ~7-day window: every response refreshes the expiry. This IS the session
    // decision — no remember-me, no device tokens, no sign-out-everywhere.
    rolling: true,
    cookie: cookieSettings.cookie,
  });

  const { csrfSynchronisedProtection, generateToken } = csrfSync({
    // Forms, not fetch(): the token travels as a hidden field.
    getTokenFromRequest: (req) => {
      const body = (req as express.Request).body as Record<string, unknown> | undefined;
      return typeof body?._csrf === "string" ? body._csrf : undefined;
    },
  });

  const fetchMetadataGuard = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    const refusal = crossSiteRefusal(req);
    if (refusal !== null) {
      res
        .status(403)
        .type("html")
        .send(
          page(
            "Refused",
            `<h1>Not recorded</h1><p>This looks like a cross-site request: ${escapeHtml(refusal)}. ` +
              "Nothing was recorded. If you are the approver, go back to the queue and act from there.</p>",
          ),
        );
      return;
    }
    next();
  };

  /** GETs render for the signed-in only; a signed-out GET is bounced to /login. A
   *  signed-out state-changing POST is a 401 page, NEVER a redirect — redirecting on
   *  failure discards a human decision silently (same discipline as /decide's `fail`). */
  const requireLogin =
    (mode: "page" | "action") =>
    async (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ): Promise<void> => {
      const refuse = (): void => {
        if (mode === "page") res.redirect(303, "/login");
        else
          res
            .status(401)
            .type("html")
            .send(
              page(
                "Not signed in",
                "<h1>Not recorded</h1><p>You are not signed in — the session is missing or " +
                  "expired. Nothing was recorded. Sign in again from /login.</p>",
              ),
            );
      };
      const userId = req.session.userId;
      if (userId === undefined) {
        refuse();
        return;
      }
      // Re-checked EVERY request, not only at login: an operator disabling an approver
      // must end her authority now, not when her rolling week runs out.
      const live = await pool.query(
        `select 1 from approval.users where id = $1 and disabled_at is null`,
        [userId],
      );
      if (live.rowCount !== 1) {
        await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
        refuse();
        return;
      }
      next();
    };

  const csrfField = (req: express.Request): string =>
    `<input type='hidden' name='_csrf' value='${escapeHtml(generateToken(req))}'>`;

  // ── Login ────────────────────────────────────────────────────────────────────────────

  app.get("/login", sessionMw, (req: express.Request, res: express.Response) => {
    res
      .status(200)
      .type("html")
      .send(
        page(
          "Sign in",
          "<h1>Sign in</h1><p>Enter the email address on your approver record and a " +
            "one-time sign-in link will be sent to it. The address must match exactly as " +
            "it was registered.</p>" +
            "<form method='post' action='/login/request'>" +
            csrfField(req) +
            "<label>Email<br><input type='email' name='email' required></label> " +
            "<button>Send me a sign-in link</button></form>",
        ),
      );
  });

  app.post(
    "/login/request",
    sessionMw,
    fetchMetadataGuard,
    form,
    csrfSynchronisedProtection,
    async (req: express.Request, res: express.Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const email = typeof body.email === "string" ? body.email : "";
      try {
        const outcome = await requestLoginLink(pool, email, opts.publicUrl, opts.sendLoginLink);
        // FOR THE OPERATOR'S LOG ONLY. The PAGE below is identical for every outcome —
        // a login page that answers differently for known addresses is an approver-list
        // oracle — but response TIMING is not: the await above rode the real SMTP send
        // for an active approver and returned early for everyone else. Disclosed in
        // login.ts's header; kept, because a failed send must earn the loud 503 below,
        // not this page.
        console.log(`[approval] login link request: ${outcome.kind}`);
      } catch (err) {
        // Infrastructure failure — database down, relay refused. LOUD, because "the mail
        // never went out" must not wear the anti-enumeration success page.
        console.error("[approval] login link request failed:", err);
        res
          .status(503)
          .type("html")
          .send(
            page(
              "Sign-in unavailable",
              "<h1>The sign-in link could not be sent</h1><p>This is a system failure, " +
                "not a wrong address. Try again, and tell your operator if it persists.</p>",
            ),
          );
        return;
      }
      res
        .status(200)
        .type("html")
        .send(
          page(
            "Check your email",
            "<h1>Check your email</h1><p>If that address belongs to an active approver, " +
              "a sign-in link is on its way. It works once and expires in 15 minutes.</p>",
          ),
        );
    },
  );

  // The emailed link lands HERE, and this GET deliberately consumes nothing: mailbox
  // providers and security scanners prefetch GET links, and a prefetch that burned the
  // token would make every legitimate login "already used". The button below posts the
  // token through the same CSRF pair as every other state change.
  app.get("/login/consume", sessionMw, (req: express.Request, res: express.Response) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (token === "") {
      res
        .status(400)
        .type("html")
        .send(page("Sign-in link invalid", "<h1>This link is incomplete</h1><p>It carries no token.</p>"));
      return;
    }
    res
      .status(200)
      .type("html")
      .send(
        page(
          "Complete sign-in",
          "<h1>Complete sign-in</h1><p>Press the button to finish signing in.</p>" +
            "<form method='post' action='/login/consume'>" +
            csrfField(req) +
            `<input type='hidden' name='token' value='${escapeHtml(token)}'>` +
            "<button>Sign in</button></form>",
        ),
      );
  });

  app.post(
    "/login/consume",
    sessionMw,
    fetchMetadataGuard,
    form,
    csrfSynchronisedProtection,
    async (req: express.Request, res: express.Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const token = typeof body.token === "string" ? body.token : "";
      const consumed = await consumeLoginToken(pool, token);
      if (consumed === null) {
        // One undifferentiated refusal for expired, used, tampered and unknown alike —
        // distinguishing them tells a token-guesser how close it is.
        res
          .status(400)
          .type("html")
          .send(
            page(
              "Sign-in link refused",
              "<h1>This link did not sign you in</h1><p>It is invalid, expired, or was " +
                "already used. Links work exactly once and expire in 15 minutes — " +
                "request a fresh one from /login.</p>",
            ),
          );
        return;
      }
      // REGENERATED, not reused: a session id that existed before authentication must not
      // survive into the authenticated state (session fixation). The new id is minted by
      // the store; the old row is destroyed by regenerate().
      await new Promise<void>((resolve, reject) =>
        req.session.regenerate((err) => (err ? reject(err) : resolve())),
      );
      req.session.userId = consumed.userId;
      try {
        // One audit row per login, BEFORE the session is answered: if the audit insert
        // fails there must be no authenticated session, so the invariant "session exists
        // ⇒ its login is on the audit trail" holds fail-closed.
        await recordLogin(pool, consumed);
      } catch (err) {
        console.error("[approval] login audit insert failed — refusing the session:", err);
        await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
        res
          .status(503)
          .type("html")
          .send(
            page(
              "Sign-in failed",
              "<h1>Sign-in could not be recorded</h1><p>The login audit row could not be " +
                "written, so no session was created. Try again.</p>",
            ),
          );
        return;
      }
      res.redirect(303, "/queue");
    },
  );

  // ── The queue and the decision ───────────────────────────────────────────────────────

  app.get(
    "/queue",
    sessionMw,
    requireLogin("page"),
    async (req: express.Request, res: express.Response) => {
      try {
        const cards = collapseDuplicates(await readPendingQueue(pool, opts.tenantId));
        const body =
          cards.length === 0
            ? // NOT a cheerful blank. An empty queue and a broken queue look identical on a
              // page, and this project's worst defect class is a silence that reads as calm.
              "<h1>Nothing pending</h1><p>The queue read succeeded and returned no live " +
              `pending proposals for tenant <code>${escapeHtml(opts.tenantId)}</code>. ` +
              "That means one of: nothing was proposed, everything was already decided, or " +
              "everything expired unseen. This page cannot yet tell you which.</p>"
            : cards
                .map(
                  (c) =>
                    "<form method='post' action='/decide'>" +
                    csrfField(req) +
                    // The card carries the id only as a data- attribute, which forms do not
                    // submit. Without this hidden field every card is undecidable.
                    `<input type='hidden' name='proposalId' value='${escapeHtml(c.primary.id)}'>` +
                    renderProposalCard({
                      id: c.primary.id,
                      action_type: c.primary.action_type,
                      payload: c.primary.payload,
                      rationale: c.primary.rationale,
                      // 🚨 `QueueRow.expires_at` is DECLARED `string` (queue.ts:25) and is a
                      // `Date` at runtime — `pg` maps timestamptz to Date. Measured, not
                      // assumed: the first real render threw `value.replace is not a
                      // function` inside `escapeHtml`. Nothing caught it because every test
                      // builds `CardRow` by hand from string literals, so the read model and
                      // the renderer had never met real data. Coerced HERE rather than
                      // changing the shared read model, which other callers depend on; the
                      // declaration itself is still wrong and is logged as a defect.
                      expires_at: new Date(c.primary.expires_at).toISOString(),
                      duplicates: c.duplicates.length,
                    }) +
                    "<label>Reason (required to reject)<br>" +
                    "<textarea name='reason' rows='2'></textarea></label>" +
                    "</form>",
                )
                .join("");
        res.status(200).type("html").send(page("Approval queue", body));
      } catch (err) {
        // FAILS LOUD. Rendering an empty list here would convert a database outage into
        // "nothing to approve" — the exact silent-empty failure the page above warns about.
        console.error("[approval] queue read failed:", err);
        res
          .status(503)
          .type("html")
          .send(
            page(
              "Queue unavailable",
              "<h1>The queue could not be read</h1><p>This is NOT an empty queue. " +
                `<code>${escapeHtml(err instanceof Error ? err.message : String(err))}</code></p>`,
            ),
          );
      }
    },
  );

  app.post(
    "/decide",
    sessionMw,
    fetchMetadataGuard,
    form,
    csrfSynchronisedProtection,
    requireLogin("action"),
    async (req: express.Request, res: express.Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const proposalId = typeof body.proposalId === "string" ? body.proposalId : "";
      const decision = typeof body.decision === "string" ? body.decision : "";
      const reason = typeof body.reason === "string" ? body.reason : "";
      // From the SESSION, and only from the session. requireLogin("action") has already
      // proven it names a live, non-disabled approver row.
      const approverUserId = req.session.userId as string;

      const fail = (status: number, msg: string): void => {
        // NEVER a redirect. Redirecting on failure discards a human decision silently and
        // returns her to a queue that looks like she never clicked.
        res
          .status(status)
          .type("html")
          .send(page("Decision refused", `<h1>Not recorded</h1><p>${escapeHtml(msg)}</p>`));
      };

      try {
        // Re-read rather than trusting the posted id to still be live: between render and
        // click the row may have expired or been decided elsewhere. This also rebuilds the
        // duplicate grouping, so the decision disposes of the same repeats the card showed.
        const cards = collapseDuplicates(await readPendingQueue(pool, opts.tenantId));
        const card: CollapsedCard | undefined = cards.find((c) => c.primary.id === proposalId);
        if (!card) {
          fail(409, `Proposal ${proposalId} is no longer pending — it expired or was decided.`);
          return;
        }

        if (decision === "approved") {
          await approveCard(pool, card, approverUserId);
        } else if (decision === "rejected") {
          await rejectCard(pool, card, approverUserId, reason);
        } else if (decision === "dismissed") {
          // Leaves the proposal pending on purpose; only an explicit click reaches here.
          await decide(pool, {
            proposalId: card.primary.id,
            kind: "dismissed",
            approverUserId,
          });
        } else {
          fail(400, `Unknown decision "${decision}".`);
          return;
        }
        res.redirect(303, "/queue");
      } catch (err) {
        if (err instanceof DecisionRefused) {
          fail(400, err.message);
          return;
        }
        console.error("[approval] decision failed:", err);
        fail(503, err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── The knowledge authoring surface (knowledge.ts) ───────────────────────────────────
  // Registered with the SAME middleware instances the decision surface uses — one session
  // store, one CSRF secret, one login gate — and BEFORE the CSRF error handler below, so
  // its stale-token refusals land on the same "Not recorded" page.
  registerKnowledgeRoutes(
    app,
    pool,
    { tenantId: opts.tenantId },
    {
      sessionMw,
      fetchMetadataGuard,
      form,
      csrfSynchronisedProtection,
      requireLogin,
      csrfField,
      page,
    },
  );

  // The synchronizer-token refusal surfaces here (csrf-sync answers via next(err)). It is
  // registered at the END of the human routes, sees only their errors, and passes
  // everything that is not a CSRF refusal straight through.
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ): void => {
      if (
        err !== null &&
        typeof err === "object" &&
        (err as { code?: unknown }).code === "EBADCSRFTOKEN"
      ) {
        res
          .status(403)
          .type("html")
          .send(
            page(
              "Refused",
              "<h1>Not recorded</h1><p>The form's anti-forgery token is missing, stale, or " +
                "from another session. Nothing was recorded. Go back to the queue and act " +
                "from a freshly loaded page.</p>",
            ),
          );
        return;
      }
      next(err);
    },
  );
}
