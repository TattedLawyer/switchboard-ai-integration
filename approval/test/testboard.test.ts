// The THROWAWAY testboard's pins — T1..T7 of the dispatch brief.
//
// WHAT THIS SURFACE IS: a disposable operator page (`/testboard`) whose whole job is
// showing OBSERVED STATE READ BACK FROM THE DATABASE after an action — because logs on
// this project have lied (three emails recorded 'sent' while the relay had refused them;
// the bounce reconciler exists because of it). Every pin here therefore asserts on what
// the DATABASE holds, never on what a handler claims.
//
// The pins:
//   T1  /testboard requires a session (mirrors the /queue auth pin).
//   T2  every POST requires valid CSRF — the path list is imported from the module under
//       test so a new POST route cannot silently escape the sweep.
//   T3  the routes REFUSE TO REGISTER without SWITCHBOARD_TESTBOARD=1 — a default app has
//       no /testboard at all, which is what makes "never ships to a client" structural.
//   T4  the read-back is REAL: approve renders the decision row's DB-generated id and the
//       honest absence of an execution row; after a real beginExecution the page shows
//       the execution row that actually exists.
//   T5  a FAILING action renders its error text, never a success state.
//   T6  model/operator-authored text is escaped (a <script> contact name renders inert).
//   T7  every section has an HONEST empty state, not a blank area.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import pg from "pg";
import { freshTestDb } from "../../ingest/test/helpers/testdb.js";
import { createApprovalApp } from "../src/server.js";
import { seedInState, SEED_TENANT } from "./helpers/seed.js";
import { beginExecution } from "../src/execute.js";
import { TESTBOARD_FLAG, TESTBOARD_POST_PATHS } from "../src/testboard.js";
import type { SendLoginLink } from "../src/login.js";

const TOKEN = "testboard-test-bearer-token";

let admin: pg.Pool;
let approvalPool: pg.Pool;
let cleanup: () => Promise<void>;
let server: http.Server;
let base: string;
let sent: Array<{ to: string; url: string }>;
let savedDatabaseUrl: string | undefined;
let savedFlag: string | undefined;
let dbUrl: string;

beforeAll(async () => {
  const r = await freshTestDb();
  admin = r.pool;
  cleanup = r.cleanup;
  dbUrl = r.url;

  // The testboard's observed-state reads run as the migration owner via DATABASE_URL
  // (operator-CLI precedent, crm/src/db.ts). Point it at THIS ephemeral db — never the
  // named `switchboard` database — and register the routes by setting the enabling flag
  // BEFORE the app is built.
  savedDatabaseUrl = process.env.DATABASE_URL;
  savedFlag = process.env[TESTBOARD_FLAG];
  process.env.DATABASE_URL = r.url;
  process.env[TESTBOARD_FLAG] = "1";

  const u = new URL(r.url);
  u.username = "switchboard_approval";
  u.password = "switchboard_approval";
  approvalPool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  approvalPool.on("error", () => {});

  sent = [];
  const sendLoginLink: SendLoginLink = async (to, url) => {
    sent.push({ to, url });
  };
  const app = createApprovalApp(approvalPool, {
    tenantId: SEED_TENANT,
    proposalToken: TOKEN,
    pendingCap: 100,
    human: {
      sessionSecret: "test-session-secret",
      cookieSecure: false, // the documented dev path (see human-auth.test.ts)
      publicUrl: "http://public.example.test",
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
  // FK order matters; kb entries reference approval.users.
  await admin.query("delete from kb.general_chunks");
  await admin.query("delete from kb.general_entries");
  await admin.query("delete from crm.answers");
  await admin.query("delete from crm.touches");
  await admin.query("delete from crm.follow_up_actions");
  await admin.query("delete from crm.follow_ups");
  await admin.query("delete from crm.phone_numbers");
  await admin.query("delete from crm.contacts");
  await admin.query("delete from crm.questions");
  await admin.query("delete from crm.question_sets");
  await admin.query("delete from crm.outreach_settings");
  await admin.query("delete from crm.sheet_reads");
  await admin.query("delete from crm.linked_sheets");
  await admin.query("delete from approval_auth.login_audit");
  await admin.query("delete from approval_auth.login_tokens");
  await admin.query("delete from approval_auth.sessions");
  await admin.query("delete from approval.executions");
  await admin.query("delete from approval.decisions");
  await admin.query("delete from approval.proposals");
  await admin.query("delete from approval.users");
});

afterAll(async () => {
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  if (savedFlag === undefined) delete process.env[TESTBOARD_FLAG];
  else process.env[TESTBOARD_FLAG] = savedFlag;
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (approvalPool) await approvalPool.end().catch(() => {});
  if (cleanup) await cleanup();
});

// ── HTTP helpers (the human-auth.test.ts idiom, verbatim where it is load-bearing) ──────

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

/** Full magic-link walk; returns the authenticated cookie. */
async function logIn(email: string): Promise<string> {
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
    { token: link.searchParams.get("token") as string, _csrf: csrfFrom(html) },
    anonCookie,
  );
  expect(consumeRes.status).toBe(303);
  // Load-bearing: the last body byte is express-session's "save committed" signal
  // (see human-auth.test.ts for the measured intermittent red without it).
  await consumeRes.text();
  const authedCookie = sidCookie(consumeRes);
  expect(authedCookie, "login must issue a fresh session cookie").toBeDefined();
  return authedCookie as string;
}

async function authedGet(cookie: string, path = "/testboard"): Promise<{ status: number; html: string }> {
  const res = await fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" });
  return { status: res.status, html: await res.text() };
}

// ── T1 — the session gate ───────────────────────────────────────────────────────────────

describe("T1: /testboard is behind the same session as /queue", () => {
  it("without a session: bounced to /login, no board bytes served", async () => {
    // mutation: remove `kit.requireLogin("page")` from the GET /testboard chain -> reds.
    //           RUN ✅ 2026-08-20 — observed: AssertionError: expected 200 to be 303 —
    //           the board served without any session. Restored, green (19).
    const res = await fetch(`${base}/testboard`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    expect(await res.text()).not.toContain("DISPOSABLE TEST SURFACE");
  });

  it("with a session: the board renders, and says what it is", async () => {
    const { email } = await seedApprover();
    const cookie = await logIn(email);
    const { status, html } = await authedGet(cookie);
    expect(status).toBe(200);
    expect(html).toContain("DISPOSABLE TEST SURFACE");
  });
});

// ── T2 — CSRF on every POST ─────────────────────────────────────────────────────────────

describe("T2: every testboard POST requires valid CSRF", () => {
  it("the module names its POST routes, and the sweep covers all of them", () => {
    // The list is imported FROM the module under test: a new POST route added without
    // extending TESTBOARD_POST_PATHS is itself a defect this file would not see, so the
    // implementation registers routes BY iterating that list — one source of truth.
    expect(TESTBOARD_POST_PATHS.length).toBeGreaterThanOrEqual(5);
    expect(TESTBOARD_POST_PATHS).toContain("/testboard/approve");
  });

  for (const path of TESTBOARD_POST_PATHS) {
    it(`${path} refuses a garbage synchronizer token`, async () => {
      // mutation: drop `kit.csrfSynchronisedProtection` from the POST chain -> reds.
      //           RUN ✅ 2026-08-20 — observed: all 5 paths failed, e.g. AssertionError:
      //           expected 200 to be 403 (and the run-cycle POST actually EXECUTED).
      //           Restored, green (19).
      const { email } = await seedApprover();
      const cookie = await logIn(email);
      const res = await formPost(path, { _csrf: "garbage", proposalId: "x" }, cookie);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("anti-forgery token");
    });

    it(`${path} refuses a cross-site request outright`, async () => {
      // mutation: drop `kit.fetchMetadataGuard` from the POST chain -> reds.
      //           RUN ✅ 2026-08-20 — observed: all 5 paths failed: expected page to
      //           contain 'cross-site' (the token check answered instead). Restored, green.
      const { email } = await seedApprover();
      const cookie = await logIn(email);
      const res = await formPost(
        path,
        { _csrf: "irrelevant", proposalId: "x" },
        cookie,
        { "sec-fetch-site": "cross-site" },
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("cross-site");
    });
  }
});

// ── T3 — a default app has NO testboard ─────────────────────────────────────────────────

describe(`T3: without ${TESTBOARD_FLAG}=1 the routes never register`, () => {
  it("a default app answers 404 on /testboard and on every testboard POST", async () => {
    // mutation: remove the flag check in registerTestboardRoutes -> reds (the default
    // app would serve a 303 redirect to /login instead of a 404).
    //           RUN ✅ 2026-08-20 — observed: AssertionError: expected 303 to be 404.
    //           Restored, green (19).
    delete process.env[TESTBOARD_FLAG];
    let server2: http.Server | undefined;
    try {
      const app2 = createApprovalApp(approvalPool, {
        tenantId: SEED_TENANT,
        proposalToken: TOKEN,
        pendingCap: 100,
        human: {
          sessionSecret: "test-session-secret",
          cookieSecure: false,
          publicUrl: "http://public.example.test",
          sendLoginLink: async () => {},
          pruneSessionIntervalSeconds: false,
        },
      });
      server2 = app2.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server2!.once("listening", () => resolve()));
      const b2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;

      const page = await fetch(`${b2}/testboard`, { redirect: "manual" });
      expect(page.status).toBe(404);
      for (const path of TESTBOARD_POST_PATHS) {
        const res = await fetch(`${b2}${path}`, { method: "POST", redirect: "manual" });
        expect(res.status, `${path} must not exist on a default app`).toBe(404);
      }
    } finally {
      process.env[TESTBOARD_FLAG] = "1";
      if (server2) await new Promise<void>((r) => server2!.close(() => r()));
    }
  });
});

// ── T4 — the read-back is REAL ──────────────────────────────────────────────────────────

describe("T4: approve renders what the DATABASE now holds, not what the handler hopes", () => {
  it("shows the decision row's DB-generated id, the honest execution absence, then the real execution row", async () => {
    // mutation: replace the approve handler's read-back render with a hardcoded
    // "approved" success page -> reds (the decision row id below is generated by the
    // database inside approveCard's transaction; no hardcoded page can contain it).
    //           RUN ✅ 2026-08-20 — observed: AssertionError: expected page not to ...
    //           to contain 'fd98fa38-8b5e-4d74-894c-9b0ffe1a76e3' (that run's decision
    //           id, absent from the hardcoded page). Restored, green (19).
    const { email } = await seedApprover();
    const cookie = await logIn(email);
    const proposalId = await seedInState(admin, { state: "pending" });

    const board = await authedGet(cookie);
    expect(board.html).toContain(proposalId); // the pending row renders
    const res = await formPost(
      "/testboard/approve",
      { _csrf: csrfFrom(board.html), proposalId },
      cookie,
    );
    expect(res.status).toBe(200);
    const html = await res.text();

    // The database's own truth, fetched independently of the page:
    const state = await admin.query(`select state from approval.proposals where id = $1`, [
      proposalId,
    ]);
    expect(state.rows[0].state).toBe("approved");
    const decision = await admin.query(
      `select id from approval.decisions where proposal_id = $1 and kind = 'approved'`,
      [proposalId],
    );
    expect(decision.rowCount).toBe(1);
    const decisionId = decision.rows[0].id as string;

    expect(html).toContain("APPROVE — read-back from the database");
    expect(html).toContain(decisionId); // DB-generated inside the transaction — unfakeable
    expect(html).toContain("No approval.executions row exists for this proposal");

    // Now the REAL spine claims it — and the page must show the row that actually exists.
    await beginExecution(approvalPool, proposalId);
    const exec = await admin.query(
      `select id, kind from approval.executions where proposal_id = $1`,
      [proposalId],
    );
    expect(exec.rowCount).toBe(1);
    expect(exec.rows[0].kind).toBe("started");

    const after = await authedGet(cookie);
    expect(after.html).toContain(exec.rows[0].id as string);
    expect(after.html).toContain("started");
    expect(after.html).not.toContain("No approval.executions row exists for this proposal");
  });
});

// ── T5 — failure is as loud as success ──────────────────────────────────────────────────

describe("T5: a failing action renders its error, never a success state", () => {
  it("approving a proposal that does not exist renders the refusal", async () => {
    // mutation: make the approve handler swallow the not-found case and render the
    // success block anyway -> reds.
    //           RUN ✅ 2026-08-20 — observed: AssertionError: expected 200 to be 409.
    //           Restored, green (19).
    const { email } = await seedApprover();
    const cookie = await logIn(email);
    const board = await authedGet(cookie);
    const ghost = "00000000-dead-4bee-8fee-000000000001";
    const res = await formPost(
      "/testboard/approve",
      { _csrf: csrfFrom(board.html), proposalId: ghost },
      cookie,
    );
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain("APPROVE FAILED");
    expect(html).toContain(ghost);
    expect(html).not.toContain("APPROVE — read-back from the database");
  });

  it("a proposer cycle whose CLI dies renders the exit code and the stderr text", async () => {
    // The real `crm-run-cycle` CLI refuses without AGENT_PROPOSAL_TOKEN — a genuine
    // throwing action, spawned for real. The page must say FAILED and carry the error.
    // mutation: render "done" on nonzero exit instead of the failure block -> reds.
    //           RUN ✅ 2026-08-20 — observed: AssertionError: expected 200 to be 500.
    //           Restored, green (19).
    const savedToken = process.env.AGENT_PROPOSAL_TOKEN;
    const savedCrmUrl = process.env.CRM_DATABASE_URL;
    delete process.env.AGENT_PROPOSAL_TOKEN;
    delete process.env.CRM_DATABASE_URL;
    try {
      const { email } = await seedApprover();
      const cookie = await logIn(email);
      const board = await authedGet(cookie);
      const res = await formPost(
        "/testboard/run-cycle",
        { _csrf: csrfFrom(board.html) },
        cookie,
      );
      expect(res.status).toBe(500);
      const html = await res.text();
      expect(html).toContain("FAILED — exit");
      expect(html).toContain("AGENT_PROPOSAL_TOKEN");
      expect(html).not.toContain("exit 0 —");
    } finally {
      if (savedToken !== undefined) process.env.AGENT_PROPOSAL_TOKEN = savedToken;
      if (savedCrmUrl !== undefined) process.env.CRM_DATABASE_URL = savedCrmUrl;
    }
  }, 60_000);
});

// ── T6 — escaping ───────────────────────────────────────────────────────────────────────

describe("T6: operator/model-authored text renders escaped", () => {
  it("a <script> contact name and knowledge title render inert", async () => {
    // mutation: interpolate display_name into the contacts row without escapeHtml -> reds.
    //           RUN ✅ 2026-08-20 — observed: AssertionError: expected page not to
    //           contain '<script>alert("owned")</script>'. Restored, green (19).
    const { id: userId, email } = await seedApprover();
    const cookie = await logIn(email);
    const payload = `<script>alert("owned")</script>`;
    await admin.query(
      `insert into crm.contacts (tenant_id, display_name, channel, source, active)
       values ($1, $2, 'call', 'manual', true)`,
      [SEED_TENANT, payload],
    );
    await admin.query(
      `insert into kb.general_entries (tenant_id, kind, title, body, created_by)
       values ($1, 'faq', $2, 'a body', $3)`,
      [SEED_TENANT, payload, userId],
    );
    const { html } = await authedGet(cookie);
    expect(html).not.toContain(payload);
    expect(html).toContain("&lt;script&gt;alert(&quot;owned&quot;)&lt;/script&gt;");
  });
});

// ── T7 — honest empty states ────────────────────────────────────────────────────────────

describe("T7: every section says it is empty, explicitly", () => {
  it("with nothing seeded, each section renders its named empty state", async () => {
    // mutation: render "" for an empty contacts read -> reds.
    //           RUN ✅ 2026-08-20 — observed: AssertionError: expected page to contain
    //           'No contacts exist for this tenant'. Restored, green (19).
    const { email } = await seedApprover();
    const cookie = await logIn(email);
    const { html } = await authedGet(cookie);
    expect(html).toContain("No contacts exist for this tenant");
    expect(html).toContain("No proposals exist for this tenant");
    expect(html).toContain("No touches exist for this tenant");
    expect(html).toContain("No knowledge entries exist for this tenant");
    expect(html).toContain("No crm.sheet_reads row exists");
  });
});

// ── T8 (beyond the brief) — the run-cycle button, live-fired end to end ─────────────────

describe("T8: the run-cycle button runs the SHIPPED CLI through this app's REAL door", () => {
  it("spawns crm-run-cycle, which POSTs /internal/proposals here; the page shows the proposal that now exists", async () => {
    // The whole loop, for real: button → child process (`tsx crm/src/cli/crm-run-cycle.ts`
    // as `switchboard_crm`) → HTTP POST through the A2 door of THIS listening server →
    // `approval.proposals` row → the action page re-reads and renders that row's id.
    // mutation: none needed beyond T4/T5 — this is the live-fire the board exists for;
    // the id assertion below can only pass off a row the DATABASE returned.
    const saved = {
      crm: process.env.CRM_DATABASE_URL,
      tok: process.env.AGENT_PROPOSAL_TOKEN,
    };
    const u = new URL(dbUrl);
    u.username = "switchboard_crm";
    u.password = "switchboard_crm";
    process.env.CRM_DATABASE_URL = u.toString();
    process.env.AGENT_PROPOSAL_TOKEN = TOKEN;
    try {
      await admin.query(
        `insert into crm.outreach_settings
           (tenant_id, window_start, window_end, timezone, opening_line,
            opening_line_no_name, default_interval_days, short_retry_days)
         values ($1, '09:00', '18:00', 'Asia/Manila',
                 'Hi, this is the assistant — may I speak with {name}?',
                 'Hi, I am an associate of the broker — do you have a moment?', 30, 3)`,
        [SEED_TENANT],
      );
      const qs = await admin.query(
        `insert into crm.question_sets (tenant_id, version) values ($1, 1) returning id`,
        [SEED_TENANT],
      );
      await admin.query(
        `insert into crm.questions (set_id, ordinal, question_key, prompt_text, answer_kind)
         values ($1, 0, 'budget', 'What budget range are you working with?', 'text')`,
        [qs.rows[0].id],
      );
      const contact = await admin.query(
        `insert into crm.contacts (tenant_id, display_name, channel, source, active, next_due_at)
         values ($1, 'Live Fire Reyes', 'call', 'manual', true, now() - interval '1 minute')
         returning id`,
        [SEED_TENANT],
      );
      await admin.query(
        `insert into crm.phone_numbers (contact_id, phone_e164, phone_raw, ordinal)
         values ($1, '+639171234567', '+639171234567', 0)`,
        [contact.rows[0].id],
      );

      const { email } = await seedApprover();
      const cookie = await logIn(email);
      const board = await authedGet(cookie);
      const res = await formPost("/testboard/run-cycle", { _csrf: csrfFrom(board.html) }, cookie);
      const html = await res.text();
      expect(res.status, html.slice(0, 2000)).toBe(200);
      expect(html).toContain("exit 0 —");

      // The database's truth, independently:
      const p = await admin.query(
        `select id, action_type, state from approval.proposals where tenant_id = $1`,
        [SEED_TENANT],
      );
      expect(p.rowCount).toBe(1);
      expect(p.rows[0].action_type).toBe("place_call");
      expect(p.rows[0].state).toBe("pending");
      // ...and the page rendered exactly that row.
      expect(html).toContain(p.rows[0].id as string);
    } finally {
      if (saved.crm === undefined) delete process.env.CRM_DATABASE_URL;
      else process.env.CRM_DATABASE_URL = saved.crm;
      if (saved.tok === undefined) delete process.env.AGENT_PROPOSAL_TOKEN;
      else process.env.AGENT_PROPOSAL_TOKEN = saved.tok;
    }
  }, 120_000);
});
