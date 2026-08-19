// The knowledge authoring surface, exercised over real HTTP — a listening server, fetch,
// cookies, forms — in human-auth.test.ts's idiom. The pins are the brief's acceptance
// list, each one performed rather than reasoned:
//
//   P1 every route requires a session (GETs bounce to /login; POSTs are refusal pages);
//   P2 POSTs require a valid synchronizer token;
//   P3 `created_by` is the SESSION's user — a forged author field in the body is inert;
//   P4 a <script> title/body renders ESCAPED everywhere it appears;
//   P5 invalid input re-renders the form WITH her typed values and inserts nothing;
//   P6 retire is a status flip, never a DELETE — the row survives, the list forgets it;
//   P7 the indexing badge reflects the 024 view: no chunks ⇒ indexing, embedded ⇒ live,
//      long-waiting ⇒ an honest stall message rather than a spinner that lies;
//   P8 an update BUMPS `updated_at` — the embed worker's staleness clause
//      (`updated_at > max(embedded_at)`, crm/src/kb/embed-pass.ts) keys on it, so an
//      update that does not bump it is an edit that is NEVER re-embedded.
//
// Fixture doctrine (crmdb.ts / seed.ts headers): entries are authored through the HTTP
// surface with a real session — the way the shipped system authors them; chunks are
// written through the CRM role — the daemon's role; only clock manipulation (backdating
// updated_at) goes through the owner pool, the way every suite here bends time.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createHash } from "node:crypto";
import pg from "pg";
import { freshTestDb } from "../../ingest/test/helpers/testdb.js";
import { createApprovalApp } from "../src/server.js";
import { KB_INDEX_STALL_MINUTES } from "../src/knowledge.js";
import { SEED_TENANT } from "./helpers/seed.js";
import type { SendLoginLink } from "../src/login.js";

const TOKEN = "knowledge-test-token";

let admin: pg.Pool;
let approvalPool: pg.Pool;
let crmPool: pg.Pool;
let cleanup: () => Promise<void>;
let server: http.Server;
let base: string;
let sent: Array<{ to: string; url: string }>;

beforeAll(async () => {
  const r = await freshTestDb();
  admin = r.pool;
  cleanup = r.cleanup;
  const u = new URL(r.url);
  u.username = "switchboard_approval";
  u.password = "switchboard_approval";
  approvalPool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  approvalPool.on("error", () => {});
  const c = new URL(r.url);
  c.username = "switchboard_crm";
  c.password = "switchboard_crm";
  crmPool = new pg.Pool({ connectionString: c.toString(), max: 2 });
  crmPool.on("error", () => {});

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
      cookieSecure: false, // the documented dev path (human-auth.test.ts's header)
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
  await admin.query("delete from kb.general_chunks");
  await admin.query("delete from kb.general_entries");
  await admin.query("delete from approval_auth.login_audit");
  await admin.query("delete from approval_auth.login_tokens");
  await admin.query("delete from approval_auth.sessions");
  await admin.query("delete from approval.users");
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (approvalPool) await approvalPool.end().catch(() => {});
  if (crmPool) await crmPool.end().catch(() => {});
  if (cleanup) await cleanup();
});

// ── HTTP plumbing, compacted from human-auth.test.ts ─────────────────────────────────────

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
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
      origin: base,
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

/** The whole front door, the way a browser walks it (human-auth.test.ts's logIn,
 *  including its load-bearing final body read — the "save completed" signal). */
async function logIn(email: string): Promise<string> {
  const loginPage = await fetch(`${base}/login`);
  const anonCookie = sidCookie(loginPage) as string;
  await formPost("/login/request", { email, _csrf: csrfFrom(await loginPage.text()) }, anonCookie);
  const link = new URL(sent[0].url);
  const confirmPage = await fetch(`${base}/login/consume${link.search}`, {
    headers: { cookie: anonCookie },
  });
  const consumeRes = await formPost(
    "/login/consume",
    { token: link.searchParams.get("token") as string, _csrf: csrfFrom(await confirmPage.text()) },
    anonCookie,
  );
  expect(consumeRes.status).toBe(303);
  await consumeRes.text();
  return sidCookie(consumeRes) as string;
}

/** Author one entry THROUGH THE SURFACE — session, CSRF and all. */
async function createEntry(
  cookie: string,
  fields: { kind?: string; title?: string; body?: string } & Record<string, string>,
): Promise<Response> {
  const formPage = await fetch(`${base}/knowledge/new`, { headers: { cookie } });
  expect(formPage.status).toBe(200);
  const csrf = csrfFrom(await formPage.text());
  return formPost(
    "/knowledge/create",
    {
      kind: "listing",
      title: "Alabang Hills 3BR",
      body: "3BR house-and-lot, Alabang Hills, ₱18.5M.",
      _csrf: csrf,
      ...fields,
    },
    cookie,
  );
}

async function entryIdByTitle(title: string): Promise<string> {
  const r = await admin.query(`select id from kb.general_entries where title = $1`, [title]);
  expect(r.rowCount).toBe(1);
  return r.rows[0].id as string;
}

async function entryCount(): Promise<number> {
  const r = await admin.query(`select count(*)::int as n from kb.general_entries`);
  return r.rows[0].n as number;
}

function vec(dim = 1024, fill = 0.5): string {
  return JSON.stringify(Array.from({ length: dim }, () => fill));
}

const sha256 = (t: string): string => createHash("sha256").update(t).digest("hex");

/** Chunk writes through the CRM pool — the daemon's role, its exact write shapes
 *  (embed-pass.ts): pending insert, embed update, supersede update. */
async function seedPendingChunk(entryId: string, ordinal: number, text: string): Promise<string> {
  const r = await crmPool.query<{ id: string }>(
    `insert into kb.general_chunks (entry_id, ordinal, text, content_hash)
     values ($1, $2, $3, $4) returning id`,
    [entryId, ordinal, text, sha256(text)],
  );
  return r.rows[0].id;
}

async function embedChunk(chunkId: string): Promise<void> {
  await crmPool.query(
    `update kb.general_chunks set embedding = $2, embedded_at = now() where id = $1`,
    [chunkId, vec()],
  );
}

async function supersedeChunk(chunkId: string): Promise<void> {
  await crmPool.query(
    `update kb.general_chunks set embedding = null, embedded_at = now() where id = $1`,
    [chunkId],
  );
}

// ── P1: every route is behind the session ────────────────────────────────────────────────

describe("P1: no session, no knowledge surface", () => {
  it("signed-out GETs are bounced to /login, no page bytes served", async () => {
    for (const path of [
      "/knowledge",
      "/knowledge/new",
      "/knowledge/00000000-0000-0000-0000-000000000001/edit",
    ]) {
      const res = await fetch(`${base}${path}`, { redirect: "manual" });
      expect(res.status, path).toBe(303);
      expect(res.headers.get("location"), path).toBe("/login");
    }
  });

  it("signed-out POSTs are refusal pages, never a redirect, and insert nothing", async () => {
    for (const path of [
      "/knowledge/create",
      "/knowledge/00000000-0000-0000-0000-000000000001/update",
      "/knowledge/00000000-0000-0000-0000-000000000001/retire",
    ]) {
      const res = await formPost(
        path,
        { kind: "faq", title: "sneaked in", body: "sneaked in" },
        undefined,
      );
      // The CSRF layer sits in front (no session, so no token could match) — either way
      // it must be a refusal page, NOT a 3xx (human-auth.test.ts's own /decide pin).
      expect([401, 403], path).toContain(res.status);
      expect(await res.text(), path).toContain("Not recorded");
    }
    expect(await entryCount()).toBe(0);
  });
});

// ── P2: POSTs are behind the synchronizer token ──────────────────────────────────────────

describe("P2: a POST with a missing or wrong token is 403 and records nothing", () => {
  it("missing and wrong _csrf are both refused; no row appears", async () => {
    const approver = await seedApprover();
    const cookie = await logIn(approver.email);

    const missing = await formPost(
      "/knowledge/create",
      { kind: "faq", title: "no token", body: "no token" },
      cookie,
    );
    expect(missing.status).toBe(403);
    expect(await missing.text()).toContain("Not recorded");

    const wrong = await formPost(
      "/knowledge/create",
      { kind: "faq", title: "bad token", body: "bad token", _csrf: "f".repeat(256) },
      cookie,
    );
    expect(wrong.status).toBe(403);

    expect(await entryCount()).toBe(0);
  });
});

// ── P3: the author is the session, never the form ────────────────────────────────────────

describe("P3: created_by comes from the SESSION", () => {
  it("a forged created_by field in the body does not change the stored author", async () => {
    const approver = await seedApprover();
    const other = await seedApprover(); // a real users row, so only attribution can fail
    const cookie = await logIn(approver.email);

    const res = await createEntry(cookie, {
      title: "attribution test",
      created_by: other.id, // the forgery: a valid, DIFFERENT approver id
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/knowledge");

    const row = await admin.query(
      `select created_by from kb.general_entries where title = 'attribution test'`,
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].created_by).toBe(approver.id);
    expect(row.rows[0].created_by).not.toBe(other.id);
  });
});

// ── P4: escaping ─────────────────────────────────────────────────────────────────────────

describe("P4: a <script> title and body render ESCAPED", () => {
  it("list page and edit page both escape; the raw payload appears nowhere", async () => {
    const approver = await seedApprover();
    const cookie = await logIn(approver.email);
    const payload = "<script>alert(1)</script>";

    const res = await createEntry(cookie, { title: payload, body: `body ${payload}` });
    expect(res.status).toBe(303);
    const id = await entryIdByTitle(payload);

    const list = await (await fetch(`${base}/knowledge`, { headers: { cookie } })).text();
    expect(list).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(list).not.toContain(payload);

    const edit = await (
      await fetch(`${base}/knowledge/${id}/edit`, { headers: { cookie } })
    ).text();
    expect(edit).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(edit).not.toContain(payload);
  });
});

// ── P5: invalid input loses nothing ──────────────────────────────────────────────────────

describe("P5: invalid input re-renders the form with her typed values and inserts nothing", () => {
  it("an unknown kind is refused; title and body survive the round trip", async () => {
    const approver = await seedApprover();
    const cookie = await logIn(approver.email);

    const res = await createEntry(cookie, {
      kind: "mixtape",
      title: "Her typed title survives",
      body: "Her typed body survives, every word of it.",
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Her typed title survives");
    expect(html).toContain("Her typed body survives, every word of it.");
    expect(html).toContain("name='_csrf'"); // the re-rendered form is submittable
    expect(await entryCount()).toBe(0);
  });

  it("a blank title is refused after trim; the body she typed is preserved", async () => {
    const approver = await seedApprover();
    const cookie = await logIn(approver.email);

    const res = await createEntry(cookie, {
      title: "   ",
      body: "The body she would lose to a careless redirect.",
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("The body she would lose to a careless redirect.");
    expect(await entryCount()).toBe(0);
  });

  it("an invalid EDIT is refused the same way and changes nothing", async () => {
    const approver = await seedApprover();
    const cookie = await logIn(approver.email);
    await createEntry(cookie, { title: "stable title", body: "stable body" });
    const id = await entryIdByTitle("stable title");

    const editPage = await fetch(`${base}/knowledge/${id}/edit`, { headers: { cookie } });
    const csrf = csrfFrom(await editPage.text());
    const res = await formPost(
      `/knowledge/${id}/update`,
      { kind: "listing", title: "", body: "her rewritten body", _csrf: csrf },
      cookie,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("her rewritten body");
    const row = await admin.query(`select title, body from kb.general_entries where id = $1`, [id]);
    expect(row.rows[0]).toEqual({ title: "stable title", body: "stable body" });
  });
});

// ── P6: retire is a status flip, never a vanished row ────────────────────────────────────

describe("P6: retiring an entry", () => {
  it("sets status/retired_at, leaves the active list, and the row SURVIVES", async () => {
    const approver = await seedApprover();
    const cookie = await logIn(approver.email);
    await createEntry(cookie, { title: "to be retired" });
    const id = await entryIdByTitle("to be retired");

    const listBefore = await (await fetch(`${base}/knowledge`, { headers: { cookie } })).text();
    expect(listBefore).toContain("to be retired");

    const csrf = csrfFrom(listBefore);
    const res = await formPost(`/knowledge/${id}/retire`, { _csrf: csrf }, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/knowledge");

    // The row is RETIRED, not deleted — no role even holds DELETE on kb (023), so a
    // route that issued one would have answered 503 here, and this row would be gone.
    const row = await admin.query(
      `select status, retired_at from kb.general_entries where id = $1`,
      [id],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].status).toBe("retired");
    expect(row.rows[0].retired_at).not.toBeNull();

    const listAfter = await (await fetch(`${base}/knowledge`, { headers: { cookie } })).text();
    expect(listAfter).not.toContain("to be retired");

    // Retiring it again is a refusal, not a silent success: the row is no longer active.
    const again = await formPost(`/knowledge/${id}/retire`, { _csrf: csrf }, cookie);
    expect(again.status).toBe(409);
  });
});

// ── P7: the badge is the 024 view, honestly rendered ─────────────────────────────────────

describe("P7: the indexing badge reflects the view", () => {
  it("the empty list is an honest empty state, not a cheerful blank", async () => {
    const approver = await seedApprover();
    const cookie = await logIn(approver.email);
    const html = await (await fetch(`${base}/knowledge`, { headers: { cookie } })).text();
    expect(html).toContain("No knowledge entries");
    expect(html).toContain("read succeeded"); // the /queue empty-state discipline
    expect(html).toContain("/knowledge/new"); // the way in
  });

  it("no chunks yet ⇒ indexing…, never live", async () => {
    const approver = await seedApprover();
    const cookie = await logIn(approver.email);
    await createEntry(cookie, { title: "fresh entry" });
    const html = await (await fetch(`${base}/knowledge`, { headers: { cookie } })).text();
    expect(html).toContain("indexing…");
    expect(html).not.toContain(">live<");
  });

  it("fully embedded ⇒ live", async () => {
    const approver = await seedApprover();
    const cookie = await logIn(approver.email);
    await createEntry(cookie, { title: "embedded entry" });
    const id = await entryIdByTitle("embedded entry");
    await embedChunk(await seedPendingChunk(id, 0, "the passage"));

    const html = await (await fetch(`${base}/knowledge`, { headers: { cookie } })).text();
    expect(html).toContain(">live<");
    expect(html).not.toContain("indexing…");
  });

  it("an embedded current generation with SUPERSEDED rows still reads live — the state the view derives from `embedding`, not `embedded_at`", async () => {
    const approver = await seedApprover();
    const cookie = await logIn(approver.email);
    await createEntry(cookie, { title: "edited entry" });
    const id = await entryIdByTitle("edited entry");
    const oldGen = await seedPendingChunk(id, 0, "the old text");
    await embedChunk(oldGen);
    await supersedeChunk(oldGen);
    await embedChunk(await seedPendingChunk(id, 1, "the new text"));

    const html = await (await fetch(`${base}/knowledge`, { headers: { cookie } })).text();
    expect(html).toContain(">live<");
  });

  it("waiting past the stall threshold ⇒ an honest stall message, not a spinner that lies", async () => {
    const approver = await seedApprover();
    const cookie = await logIn(approver.email);
    await createEntry(cookie, { title: "stuck entry" });
    const id = await entryIdByTitle("stuck entry");
    // Bend time the way every suite here does — through the owner pool: the entry has
    // been waiting (stall + 45) minutes with no chunk to show for it.
    await admin.query(
      `update kb.general_entries
          set updated_at = now() - make_interval(mins => $2::int)
        where id = $1`,
      [id, KB_INDEX_STALL_MINUTES + 45],
    );
    const html = await (await fetch(`${base}/knowledge`, { headers: { cookie } })).text();
    expect(html).toContain("still not indexed after");
    expect(html).not.toContain("indexing…");
    expect(html).not.toContain(">live<");
  });
});

// ── P8: an edit bumps updated_at — the re-embedding contract ─────────────────────────────

describe("P8: /knowledge/:id/update bumps updated_at", () => {
  it("the stored updated_at moves forward, so the embed worker's staleness clause fires", async () => {
    const approver = await seedApprover();
    const cookie = await logIn(approver.email);
    await createEntry(cookie, { title: "before edit", body: "the old body" });
    const id = await entryIdByTitle("before edit");

    // Make the bump unmistakable: park updated_at an hour in the past, and give the
    // entry an embedded chunk whose embedded_at is NOW — the exact configuration in
    // which a non-bumping update means "her edit is NEVER re-embedded" (the candidate
    // clause `updated_at > max(embedded_at)` would never fire again).
    await embedChunk(await seedPendingChunk(id, 0, "the old body"));
    await admin.query(
      `update kb.general_entries set updated_at = now() - interval '1 hour' where id = $1`,
      [id],
    );

    const editPage = await fetch(`${base}/knowledge/${id}/edit`, { headers: { cookie } });
    const csrf = csrfFrom(await editPage.text());
    const res = await formPost(
      `/knowledge/${id}/update`,
      { kind: "listing", title: "after edit", body: "the corrected body", _csrf: csrf },
      cookie,
    );
    expect(res.status).toBe(303);

    const row = await admin.query(
      `select title, body,
              (updated_at > (select max(embedded_at) from kb.general_chunks
                              where entry_id = $1)) as stale_again
         from kb.general_entries where id = $1`,
      [id],
    );
    expect(row.rows[0].title).toBe("after edit");
    expect(row.rows[0].body).toBe("the corrected body");
    // THE CONTRACT: the edit re-arms the worker's candidate query.
    expect(row.rows[0].stale_again).toBe(true);
  });
});
