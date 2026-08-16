// A0b — the authenticated human surface, exercised over real HTTP: a listening server,
// fetch, cookies, forms. The properties pinned here are the acceptance list of the A0b
// brief, each one performed rather than reasoned:
//
//   · /queue is REFUSED without a session and served with one;
//   · the magic-link flow establishes a session, and the session id is REGENERATED at
//     login (a pre-login sid never becomes an authenticated one);
//   · a decision is attributed to the SESSION's user — there is no operator-id option
//     left to attribute it to;
//   · CSRF is enforced twice: the synchronizer token AND the Sec-Fetch-Site/Origin pair;
//   · the bearer door still works and emits NO Set-Cookie.
//
// The tests run with `cookieSecure: false` — the DOCUMENTED dev path (config.ts
// `cookieInsecureDev`): a `__Host-`/Secure cookie does not exist over the plain-http
// loopback these tests listen on, and express-session itself refuses to set a Secure
// cookie on a non-TLS socket. The production cookie's attributes are pinned separately
// below via `sessionCookieSettings(true)`, which is exactly the object the middleware is
// built from.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import pg from "pg";
import { freshTestDb } from "../../ingest/test/helpers/testdb.js";
import { createApprovalApp } from "../src/server.js";
import { sessionCookieSettings } from "../src/human.js";
import { seedInState, SEED_TENANT } from "./helpers/seed.js";
import type { SendLoginLink } from "../src/login.js";

const TOKEN = "human-auth-test-token";

let admin: pg.Pool;
let approvalPool: pg.Pool;
let cleanup: () => Promise<void>;
let server: http.Server;
let base: string;
let sent: Array<{ to: string; url: string }>;
let sendFailure: Error | null = null;

beforeAll(async () => {
  const r = await freshTestDb();
  admin = r.pool;
  cleanup = r.cleanup;
  const u = new URL(r.url);
  u.username = "switchboard_approval";
  u.password = "switchboard_approval";
  approvalPool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  approvalPool.on("error", () => {});

  sent = [];
  const sendLoginLink: SendLoginLink = async (to, url) => {
    // The failure seam: a test sets `sendFailure` to make THIS request's delivery fail
    // the way a refused relay would — after the token row is written, before any mail.
    if (sendFailure !== null) throw sendFailure;
    sent.push({ to, url });
  };
  const app = createApprovalApp(approvalPool, {
    tenantId: SEED_TENANT,
    proposalToken: TOKEN,
    pendingCap: 100,
    human: {
      sessionSecret: "test-session-secret",
      cookieSecure: false, // the documented dev path; production attributes pinned below
      publicUrl: "http://public.example.test", // links are parsed, never fetched, in here
      sendLoginLink,
      pruneSessionIntervalSeconds: false,
    },
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterEach(async () => {
  sent.length = 0;
  sendFailure = null;
  await admin.query("delete from approval_auth.login_audit");
  await admin.query("delete from approval_auth.login_tokens");
  await admin.query("delete from approval_auth.sessions");
  await admin.query("delete from approval.executions");
  await admin.query("delete from approval.decisions");
  await admin.query("delete from approval.proposals");
  await admin.query("delete from approval.users");
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (approvalPool) await approvalPool.end().catch(() => {});
  if (cleanup) await cleanup();
});

// ── Small HTTP helpers: cookie jar and form plumbing ─────────────────────────────────────

const sidCookie = (res: Response): string | undefined =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("approval.sid="));

const csrfFrom = (html: string): string => {
  const m = html.match(/name='_csrf' value='([^']+)'/);
  if (!m) throw new Error(`no _csrf field in page: ${html.slice(0, 200)}`);
  return m[1];
};

/** A same-origin browser form POST: cookie, urlencoded body, and an Origin header that
 *  matches the host — which is what every real browser sends. */
async function formPost(
  path: string,
  fields: Record<string, string>,
  cookie: string | undefined,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
      ...("origin" in headers || "sec-fetch-site" in headers ? {} : { origin: base }),
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

async function seedApprover(): Promise<{ id: string; email: string }> {
  const email = `approver-${Math.random().toString(36).slice(2)}@example.com`;
  const r = await admin.query(`insert into approval.users (email) values ($1) returning id`, [
    email,
  ]);
  return { id: r.rows[0].id as string, email };
}

/** The whole front door, the way a browser walks it: login page -> request link ->
 *  emailed link -> confirm form -> session. Returns the authenticated cookie and the sid
 *  cookies observed before and after login (for the regeneration pin). */
async function logIn(email: string): Promise<{
  cookie: string;
  preLoginSid: string;
  postLoginSid: string;
}> {
  const loginPage = await fetch(`${base}/login`);
  const anonCookie = sidCookie(loginPage);
  expect(anonCookie, "GET /login must establish the CSRF-carrying session").toBeDefined();
  const requestRes = await formPost(
    "/login/request",
    { email, _csrf: csrfFrom(await loginPage.text()) },
    anonCookie,
  );
  expect(requestRes.status).toBe(200);
  expect(sent).toHaveLength(1);

  const link = new URL(sent[0].url);
  const confirmPage = await fetch(`${base}/login/consume${link.search}`, {
    headers: { cookie: anonCookie as string },
  });
  expect(confirmPage.status).toBe(200);
  const html = await confirmPage.text();
  const consumeRes = await formPost(
    "/login/consume",
    {
      token: link.searchParams.get("token") as string,
      _csrf: csrfFrom(html),
    },
    anonCookie,
  );
  expect(consumeRes.status).toBe(303);
  expect(consumeRes.headers.get("location")).toBe("/queue");
  // 🚨 SEQUENCING POINT, not tidiness — this line is load-bearing and was found by a
  // real intermittent red. undici's fetch resolves at HEADERS, while express-session
  // deliberately withholds the LAST BODY BYTE until the store save commits (its "split
  // response" end-wrapper). Skipping the body let the next request outrun the session
  // INSERT under suite load: the store missed the sid, express-session minted a fresh
  // session, and the fresh session's empty csrfToken answered 403 to a valid token —
  // observed 2026-08-16, roughly 1 run in 10. Reading the body IS the "save completed"
  // signal. (A browser has the same theoretical window on a 303; its next navigation
  // rides a full round trip, so the window is real but unobservably small there.)
  await consumeRes.text();
  const authedCookie = sidCookie(consumeRes);
  expect(authedCookie, "login must issue a fresh session cookie").toBeDefined();
  return {
    cookie: authedCookie as string,
    preLoginSid: anonCookie as string,
    postLoginSid: authedCookie as string,
  };
}

// ── The pins ─────────────────────────────────────────────────────────────────────────────

describe("A0b: /queue is behind the session", () => {
  it("without a session: bounced to /login, no queue bytes served", async () => {
    // mutation: remove `requireLogin("page")` from the /queue route chain -> reds.
    //           RUN ✅ 2026-08-16 — observed: AssertionError: expected 200 to be 303 —
    //           the queue served without any session. Restored, green (14).
    const res = await fetch(`${base}/queue`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("disabling an approver ends her authority NOW — the live session dies on the next request", async () => {
    // The property human.ts promises beside its per-request recheck: "an operator
    // disabling an approver must end her authority now, not when her rolling week runs
    // out." The consume-time disabled check is pinned elsewhere (login.test.ts); THIS pin
    // is the only one on the per-request session recheck — an independent review deleted
    // that block and every test here stayed green, which is exactly the unpinned gap this
    // test closes.
    // mutation: delete the `select 1 from approval.users … disabled_at is null` recheck
    //           (query + destroy + refuse block) from requireLogin in human.ts -> reds.
    //           RUN ✅ 2026-08-16 (twice: as first written, and re-run after the review
    //           strengthened the `before` binding below) — observed both times:
    //           AssertionError: expected 200 to be 303 — the disabled approver's cookie
    //           kept serving the queue; only this test red. Restored, green (16).
    const approver = await seedApprover();
    const { cookie } = await logIn(approver.email);
    // redirect: "manual" + the queue marker, so a 200 here can ONLY mean the queue was
    // served — a wholesale-broken login that bounced to /login (200) cannot pass this
    // vacuously (review addition, 2026-08-16).
    const before = await fetch(`${base}/queue`, { redirect: "manual", headers: { cookie } });
    expect(before.status).toBe(200);
    expect(await before.text()).toContain("Approval queue");

    // The operator acts: directly in the database, the way approval-user-add's
    // counterpart would — no HTTP surface participates in the disabling.
    await admin.query(`update approval.users set disabled_at = now() where id = $1`, [
      approver.id,
    ]);

    const after = await fetch(`${base}/queue`, { redirect: "manual", headers: { cookie } });
    expect(after.status).toBe(303);
    expect(after.headers.get("location")).toBe("/login");
    expect(await after.text()).not.toContain("Approval queue");

    // ...and the session was DESTROYED, not merely gated: re-enabling the approver does
    // not resurrect the old cookie — she signs in again, on a fresh link.
    await admin.query(`update approval.users set disabled_at = null where id = $1`, [
      approver.id,
    ]);
    const resurrected = await fetch(`${base}/queue`, {
      redirect: "manual",
      headers: { cookie },
    });
    expect(resurrected.status).toBe(303);
    const sessions = await admin.query(
      `select count(*)::int as n from approval_auth.sessions`,
    );
    expect(sessions.rows[0].n).toBe(0);
  });

  it("with a session: served, cards and all", async () => {
    const approver = await seedApprover();
    await seedInState(admin, { payload: { to: "jane@client.example.com", n: 1 } });
    const { cookie } = await logIn(approver.email);
    const res = await fetch(`${base}/queue`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Approval queue");
    expect(html).toContain("name='_csrf'"); // every decide form carries the token
  });
});

describe("A0b: the login flow itself", () => {
  it("regenerates the session id at login — the pre-login sid never becomes authenticated", async () => {
    // mutation: delete the `req.session.regenerate(...)` await from /login/consume in
    //           human.ts (userId assigned onto the pre-login session) -> reds.
    //           RUN ✅ 2026-08-16 — observed: AssertionError: expected
    //           'approval.sid=s%3A5AN7f0cRobC_TsX50TXh…' not to be the same string —
    //           the pre-login sid became the authenticated sid. Restored, green (14).
    const approver = await seedApprover();
    const { preLoginSid, postLoginSid, cookie } = await logIn(approver.email);
    expect(postLoginSid).not.toBe(preLoginSid);
    // ...and the OLD sid is dead, not merely renamed: presenting it earns the bounce.
    const stale = await fetch(`${base}/queue`, {
      redirect: "manual",
      headers: { cookie: preLoginSid },
    });
    expect(stale.status).toBe(303);
    // ...while the new one is live.
    const fresh = await fetch(`${base}/queue`, { headers: { cookie } });
    expect(fresh.status).toBe(200);
  });

  it("the SAME link a second time is refused, and no second audit row appears", async () => {
    const approver = await seedApprover();
    const { cookie } = await logIn(approver.email);
    // Replay the identical consume, fresh confirm page and all — the way a forwarded
    // email or a mailbox thief would.
    const link = new URL(sent[0].url);
    const confirmPage = await fetch(`${base}/login/consume${link.search}`, {
      headers: { cookie },
    });
    const res = await formPost(
      "/login/consume",
      {
        token: link.searchParams.get("token") as string,
        _csrf: csrfFrom(await confirmPage.text()),
      },
      cookie,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("already used");
    const audit = await admin.query(`select count(*)::int as n from approval_auth.login_audit`);
    expect(audit.rows[0].n).toBe(1);
  });

  it("an expired link and a tampered link are both refused with the same page", async () => {
    const approver = await seedApprover();
    // Mint a link but do not consume it; expire it under the approver's feet.
    const loginPage = await fetch(`${base}/login`);
    const anonCookie = sidCookie(loginPage) as string;
    await formPost(
      "/login/request",
      { email: approver.email, _csrf: csrfFrom(await loginPage.text()) },
      anonCookie,
    );
    const link = new URL(sent[0].url);
    await admin.query(
      `update approval_auth.login_tokens set expires_at = now() - interval '1 second'`,
    );
    const confirm = await fetch(`${base}/login/consume${link.search}`, {
      headers: { cookie: anonCookie },
    });
    const expired = await formPost(
      "/login/consume",
      { token: link.searchParams.get("token") as string, _csrf: csrfFrom(await confirm.text()) },
      anonCookie,
    );
    expect(expired.status).toBe(400);

    const raw = link.searchParams.get("token") as string;
    const tampered = (raw[0] === "A" ? "B" : "A") + raw.slice(1);
    const confirm2 = await fetch(`${base}/login/consume?token=${tampered}`, {
      headers: { cookie: anonCookie },
    });
    const refused = await formPost(
      "/login/consume",
      { token: tampered, _csrf: csrfFrom(await confirm2.text()) },
      anonCookie,
    );
    expect(refused.status).toBe(400);
    // One undifferentiated message for both — a token-guesser learns nothing.
    expect(await refused.text()).toContain("invalid, expired, or was already used");
  });

  it("a FAILED send is a loud 503 to the requester, never the success page — and the token row was written first", async () => {
    // THE justification for keeping the send on the response path (login.ts's disclosed
    // timing deviation) is that a failed send earns the requester a loud 503 instead of
    // wearing the anti-enumeration success page. Until this test, that property had the
    // same shape as the disabled-recheck gap above: promised in two comments, pinned by
    // nothing. This also pins write-before-send: the orphan token row must already exist,
    // because the reverse order can mail a link whose token was never recorded.
    // mutation: absorb the send failure in POST /login/request — replace the catch
    //           block's 503 response + return with the log line only, falling through to
    //           the success render (the "refactor absorbs the rejection" defect) -> reds.
    //           RUN ✅ 2026-08-16 — observed: AssertionError: expected 200 to be 503 —
    //           the failed send wore the "Check your email" page. Restored, green (16).
    const approver = await seedApprover();
    const loginPage = await fetch(`${base}/login`);
    const anonCookie = sidCookie(loginPage);
    sendFailure = new Error("relay refused: 554 rejected for policy reasons");
    const res = await formPost(
      "/login/request",
      { email: approver.email, _csrf: csrfFrom(await loginPage.text()) },
      anonCookie,
    );
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("could not be sent");
    expect(html).not.toContain("Check your email");
    // Write-before-send, on the wire: one dead token row, unused — the disclosed cost of
    // the ordering, retryable by clicking "send me a link" again.
    const rows = await admin.query(`select used_at from approval_auth.login_tokens`);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].used_at).toBeNull();
  });

  it("one audit row per login — the ADR's requirement, on the wire", async () => {
    const approver = await seedApprover();
    await logIn(approver.email);
    const audit = await admin.query(
      `select user_id from approval_auth.login_audit`,
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].user_id).toBe(approver.id);
  });
});

describe("A0b: deciding is the SESSION's user, behind the CSRF pair", () => {
  it("records the decision with approver_user_id = the logged-in user — no env var anywhere", async () => {
    // mutation: replace `req.session.userId` with a fixed uuid in /decide -> reds.
    //           RUN ✅ 2026-08-16 — observed: the decisions FK refused the fabricated
    //           approver (23503, `decisions_approver_user_id_fkey`), /decide answered
    //           503, AssertionError: expected 503 to be 303. Two layers red at once:
    //           this pin, and 015's "an unattributed approval is not representable".
    //           Restored, green (14).
    const approver = await seedApprover();
    const proposalId = await seedInState(admin, { payload: { to: "jane@client.example.com", n: 2 } });
    const { cookie } = await logIn(approver.email);
    const queueHtml = await (await fetch(`${base}/queue`, { headers: { cookie } })).text();
    const res = await formPost(
      "/decide",
      { proposalId, decision: "approved", reason: "", _csrf: csrfFrom(queueHtml) },
      cookie,
    );
    expect(res.status).toBe(303);
    const decision = await admin.query(
      `select kind, approver_user_id from approval.decisions where proposal_id = $1`,
      [proposalId],
    );
    expect(decision.rowCount).toBe(1);
    expect(decision.rows[0]).toEqual({ kind: "approved", approver_user_id: approver.id });
    const state = await admin.query(`select state from approval.proposals where id = $1`, [
      proposalId,
    ]);
    expect(state.rows[0].state).toBe("approved");
  });

  it("a POST with a MISSING or WRONG synchronizer token is 403 and records nothing", async () => {
    // mutation: drop csrfSynchronisedProtection from the /decide chain -> reds.
    //           RUN ✅ 2026-08-16 — observed: AssertionError: expected 303 to be 403 —
    //           the token-less POST recorded a decision. Restored, green (14).
    const approver = await seedApprover();
    const proposalId = await seedInState(admin, { payload: { to: "jane@client.example.com", n: 3 } });
    const { cookie } = await logIn(approver.email);

    const missing = await formPost("/decide", { proposalId, decision: "approved" }, cookie);
    expect(missing.status).toBe(403);
    expect(await missing.text()).toContain("Not recorded");

    const wrong = await formPost(
      "/decide",
      { proposalId, decision: "approved", _csrf: "f".repeat(256) },
      cookie,
    );
    expect(wrong.status).toBe(403);

    const decisions = await admin.query(`select count(*)::int as n from approval.decisions`);
    expect(decisions.rows[0].n).toBe(0);
    const state = await admin.query(`select state from approval.proposals where id = $1`, [
      proposalId,
    ]);
    expect(state.rows[0].state).toBe("pending");
  });

  it("a cross-site POST is 403 even WITH a valid token: Sec-Fetch-Site is checked first", async () => {
    // mutation: delete fetchMetadataGuard from the /decide chain -> reds (this request
    //           carries a valid session AND a valid token, so only the header check can
    //           refuse it). RUN ✅ 2026-08-16 — observed: AssertionError: expected 303
    //           to be 403 — the cross-site POST recorded a decision. Restored, green (14).
    const approver = await seedApprover();
    const proposalId = await seedInState(admin, { payload: { to: "jane@client.example.com", n: 4 } });
    const { cookie } = await logIn(approver.email);
    const queueHtml = await (await fetch(`${base}/queue`, { headers: { cookie } })).text();
    const csrf = csrfFrom(queueHtml);

    const crossSite = await formPost(
      "/decide",
      { proposalId, decision: "approved", _csrf: csrf },
      cookie,
      { "sec-fetch-site": "cross-site" },
    );
    expect(crossSite.status).toBe(403);
    expect(await crossSite.text()).toContain("cross-site");

    // The Origin fallback: a foreign Origin with no Fetch-Metadata is refused...
    const foreignOrigin = await formPost(
      "/decide",
      { proposalId, decision: "approved", _csrf: csrf },
      cookie,
      { origin: "https://evil.example.net" },
    );
    expect(foreignOrigin.status).toBe(403);

    // ...and so is a request carrying NEITHER header: absence must not be the cheap pass.
    const headerless = await fetch(`${base}/decide`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ proposalId, decision: "approved", _csrf: csrf }).toString(),
    });
    expect(headerless.status).toBe(403);

    const state = await admin.query(`select state from approval.proposals where id = $1`, [
      proposalId,
    ]);
    expect(state.rows[0].state).toBe("pending");
  });

  it("a signed-out POST to /decide is a 401 page, never a redirect that eats the click", async () => {
    const proposalId = await seedInState(admin, { payload: { to: "jane@client.example.com", n: 5 } });
    const res = await formPost("/decide", { proposalId, decision: "approved" }, undefined);
    // The CSRF layer sits in front (no session, so no token could match) — either way it
    // must be a refusal page, NOT a 3xx.
    expect([401, 403]).toContain(res.status);
    expect(await res.text()).toContain("Not recorded");
  });

  it("the stale-card 409 and duplicate disposal survived the auth wrap", async () => {
    const approver = await seedApprover();
    const payload = { to: "jane@client.example.com", n: 6 };
    const a = await seedInState(admin, { payload, rationale: "same" });
    const b = await seedInState(admin, { payload, rationale: "same" });
    const { cookie } = await logIn(approver.email);
    const queueHtml = await (await fetch(`${base}/queue`, { headers: { cookie } })).text();
    const csrf = csrfFrom(queueHtml);

    const ok = await formPost(
      "/decide",
      { proposalId: a, decision: "approved", _csrf: csrf },
      cookie,
    );
    expect(ok.status).toBe(303);
    const dup = await admin.query(`select state from approval.proposals where id = $1`, [b]);
    expect(dup.rows[0].state).toBe("superseded");

    // The card is gone now; deciding it again is the 409, not a silent success. The
    // synchronizer token is per-session, not per-page, so the one from the first queue
    // render is still the session's token — which is exactly the stale-tab scenario.
    const stale = await formPost(
      "/decide",
      { proposalId: a, decision: "rejected", reason: "changed my mind", _csrf: csrf },
      cookie,
    );
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("no longer pending");
  });
});

describe("A0b: the bearer door is untouched", () => {
  it("still answers 201 with the bearer token, and emits NO Set-Cookie", async () => {
    // mutation, TWO variants, both RUN 2026-08-16 and one of them is a FINDING:
    //   1. `app.use(sessionMw)` inside registerHumanRoutes — did NOT red (14 passed).
    //      Registration ORDER protects the door structurally: human routes register
    //      after it, so an app-wide use() added there sits behind the door in the
    //      stack and never runs for /internal/proposals. The stated hazard cannot be
    //      introduced from inside registerHumanRoutes at all.
    //   2. `app.use(session({...}))` at the TOP of createApprovalApp, BEFORE the door —
    //      the mutation this pin actually guards against — RED ✅: observed
    //      AssertionError: expected [ Array(1) ] to deeply equal [], with
    //      "connect.sid=s%3A5FVF…; Path=/; HttpOnly" in getSetCookie(): the bearer
    //      door issuing cookies, exactly the door-contract change the server.ts header
    //      forbids. Restored, green (14).
    const res = await fetch(`${base}/internal/proposals`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        idempotency_key: `door-${Math.random().toString(36).slice(2)}`,
        action_type: "send_email",
        payload: { to: "jane@client.example.com" },
        rationale: "door still works",
      }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("a session cookie is NOT a door credential: /internal/proposals still wants the bearer", async () => {
    const approver = await seedApprover();
    const { cookie } = await logIn(approver.email);
    const res = await fetch(`${base}/internal/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});

describe("A0b: the production cookie, pinned without TLS", () => {
  it("sessionCookieSettings(true) is __Host-, Secure, HttpOnly, SameSite=Lax, Path=/, ~7d", () => {
    // This object IS what the middleware is constructed from; over plain http the
    // browser-visible header cannot carry Secure, so the attributes are pinned at the
    // source instead. The dev variant must NOT wear the prefix — a __Host- name without
    // Secure is a lie the browser would refuse anyway.
    expect(sessionCookieSettings(true)).toEqual({
      name: "__Host-approval.sid",
      cookie: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    });
    expect(sessionCookieSettings(false).name).toBe("approval.sid");
    expect(sessionCookieSettings(false).cookie.secure).toBe(false);
  });
});
