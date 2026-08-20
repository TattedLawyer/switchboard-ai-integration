// Business-card capture — the on-ramp to the follow-up loop, exercised over real HTTP the
// way human-auth.test.ts exercises the decision surface: a listening server, fetch,
// cookies, forms, an ephemeral database per suite.
//
// THE TWO OWNER RULINGS THIS SUITE PINS:
//   1. SHE CONFIRMS THE EXTRACTED FIELDS before any contact exists (C3: the stored value
//      is HER edit, never the extractor's).
//   2. THE PHOTO IS NEVER PERSISTED (C2: a sentinel-carrying image, then every table in
//      the database is scanned for the sentinel in plain, hex and base64 forms, and every
//      fs write API is spied for the duration of the cycle).
//
// CROSS-WORKSPACE IMPORTS BELOW (claimDue, normalizePhone): test code is the established
// exception to the cross-workspace import ban (crm/test/executor.test.ts:29 precedent) —
// C4 must assert against the REAL due-query, not a re-implementation of it.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import fs from "node:fs";
import pg from "pg";
import { freshTestDb } from "../../ingest/test/helpers/testdb.js";
import { claimDue } from "../../crm/src/claim.js";
import { createApprovalApp } from "../src/server.js";
import { provideCardExtractor } from "../src/card-capture.js";
import { vendorExtractCard } from "../src/card-extract.js";
import { SEED_TENANT } from "./helpers/seed.js";
import type { SendLoginLink } from "../src/login.js";
import type express from "express";

const TOKEN = "card-capture-test-token";

let admin: pg.Pool;
let approvalPool: pg.Pool;
let crmPool: pg.Pool;
let cleanup: () => Promise<void>;
let server: http.Server;
let base: string;
let app: express.Express;
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
  app = createApprovalApp(approvalPool, {
    tenantId: SEED_TENANT,
    proposalToken: TOKEN,
    pendingCap: 100,
    human: {
      sessionSecret: "test-session-secret",
      cookieSecure: false, // the documented dev path (human-auth.test.ts header)
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
  provideCardExtractor(app, undefined); // back to the default stub between tests
  vi.restoreAllMocks();
  await admin.query("delete from crm.phone_numbers");
  await admin.query("delete from crm.contacts");
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

// ── HTTP plumbing (the human-auth.test.ts idiom) ─────────────────────────────────────────

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

/** A same-origin browser multipart POST — the photo upload. */
async function multipartPost(
  path: string,
  fields: Record<string, string>,
  file: { field: string; filename: string; contentType: string; bytes: Uint8Array } | null,
  cookie: string | undefined,
  headers: Record<string, string> = {},
): Promise<Response> {
  const boundary = `----cardtest${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        "utf8",
      ),
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="${file.field}"; ` +
          `filename="${file.filename}"\r\ncontent-type: ${file.contentType}\r\n\r\n`,
        "utf8",
      ),
      Buffer.from(file.bytes),
      Buffer.from("\r\n", "utf8"),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  const body = Buffer.concat(parts);
  return fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      ...(cookie ? { cookie } : {}),
      ...("origin" in headers || "sec-fetch-site" in headers ? {} : { origin: base }),
      ...headers,
    },
    body,
  });
}

async function seedApprover(): Promise<{ id: string; email: string }> {
  const email = `approver-${Math.random().toString(36).slice(2)}@example.com`;
  const r = await admin.query(`insert into approval.users (email) values ($1) returning id`, [
    email,
  ]);
  return { id: r.rows[0].id as string, email };
}

/** The whole front door, the way a browser walks it (human-auth.test.ts's logIn). */
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
  const html = await confirmPage.text();
  const consumeRes = await formPost(
    "/login/consume",
    { token: link.searchParams.get("token") as string, _csrf: csrfFrom(html) },
    anonCookie,
  );
  expect(consumeRes.status).toBe(303);
  // Load-bearing sequencing point — see human-auth.test.ts: reading the body IS the
  // "session save completed" signal; skipping it loses the race under suite load.
  await consumeRes.text();
  const authed = sidCookie(consumeRes);
  expect(authed, "login must issue a fresh session cookie").toBeDefined();
  return authed as string;
}

async function signIn(): Promise<string> {
  const { email } = await seedApprover();
  return logIn(email);
}

/** A sentinel-carrying "photo": PNG magic bytes, then ASCII the extractor and the
 *  persistence scan can both recognise. The sentinel is what C2's scan hunts for. */
function sentinelImage(sentinel: string): Uint8Array {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(sentinel, "ascii"),
  ]);
}

/** Parse every input/textarea of the ONE form posting to `action` — the browser's view of
 *  the form, hidden fields included, so a mutation that smuggles extractor values through
 *  a hidden field is carried by the test exactly as a browser would carry it. */
function parseForm(html: string, action: string): Record<string, string> {
  const unescape = (v: string): string =>
    v
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  const formMatch = html.match(
    new RegExp(`<form method='post' action='${action}'>([\\s\\S]*?)</form>`),
  );
  if (!formMatch) throw new Error(`no form posting to ${action} in page: ${html.slice(0, 300)}`);
  const fields: Record<string, string> = {};
  for (const m of formMatch[1].matchAll(/<input[^>]*name='([^']+)'[^>]*>/g)) {
    const value = /value='([^']*)'/.exec(m[0]);
    fields[unescape(m[1])] = value ? unescape(value[1]) : "";
  }
  for (const m of formMatch[1].matchAll(
    /<textarea[^>]*name='([^']+)'[^>]*>([\s\S]*?)<\/textarea>/g,
  )) {
    fields[unescape(m[1])] = unescape(m[2]);
  }
  return fields;
}

/** The TWO upload affordances on /cards, told apart by the one attribute that separates
 *  them: the camera form's file input carries `capture='environment'`; the saved-photo
 *  form's file input has NO capture attribute at all (MDN documents `capture` as a hint a
 *  browser may ignore — the page makes the choice explicit instead). Returns that form's
 *  own action and CSRF token, so a test walks whichever door a browser would. */
function uploadForm(
  html: string,
  kind: "camera" | "saved-photo",
): { action: string; csrf: string } {
  const forms = html.matchAll(
    /<form method='post' action='([^']+)' enctype='multipart\/form-data'>([\s\S]*?)<\/form>/g,
  );
  for (const m of forms) {
    const fileInput = /<input[^>]*type='file'[^>]*>/.exec(m[2])?.[0];
    if (fileInput === undefined) continue;
    if ((kind === "camera") === /\scapture=/.test(fileInput)) {
      const csrf = /name='_csrf' value='([^']+)'/.exec(m[2]);
      if (!csrf) throw new Error(`the ${kind} upload form carries no _csrf field`);
      return { action: m[1], csrf: csrf[1] };
    }
  }
  throw new Error(`no ${kind} upload form on the page: ${html.slice(0, 300)}`);
}

// ── C1: every route is behind the session; every POST is behind CSRF ─────────────────────

describe("C1: all card routes require a session, all POSTs require CSRF", () => {
  it("GET /cards, /cards/manual and /cards/created/:id without a session bounce to /login", async () => {
    for (const path of [
      "/cards",
      "/cards/manual",
      "/cards/created/00000000-0000-0000-0000-000000000001",
    ]) {
      const res = await fetch(`${base}${path}`, { redirect: "manual" });
      expect(res.status, `${path} must redirect the signed-out to /login`).toBe(303);
      expect(res.headers.get("location")).toBe("/login");
    }
  });

  it("POST /cards/extract and /cards/create without a session are refusals, never a redirect", async () => {
    // 401 or 403 — the same latitude human-auth.test.ts:493 pins for /decide: whichever
    // of the login gate and the CSRF pair refuses first, a signed-out POST is REFUSED,
    // never redirected (a redirect eats her click), and nothing is recorded.
    const ext = await multipartPost(
      "/cards/extract",
      { _csrf: "irrelevant" },
      { field: "photo", filename: "c.png", contentType: "image/png", bytes: sentinelImage("x") },
      undefined,
    );
    expect([401, 403]).toContain(ext.status);
    const cre = await formPost("/cards/create", { _csrf: "irrelevant", name: "X" }, undefined);
    expect([401, 403]).toContain(cre.status);
    const rows = await admin.query("select count(*)::int as n from crm.contacts");
    expect(rows.rows[0].n).toBe(0);
  });

  it("a signed-in POST with a missing or stale CSRF token is 403 and records nothing", async () => {
    const cookie = await signIn();
    const noToken = await formPost("/cards/create", { name: "Ana" }, cookie);
    expect(noToken.status).toBe(403);
    const staleToken = await formPost(
      "/cards/create",
      { name: "Ana", _csrf: "not-the-session-token" },
      cookie,
    );
    expect(staleToken.status).toBe(403);
    const extNoToken = await multipartPost(
      "/cards/extract",
      {},
      { field: "photo", filename: "c.png", contentType: "image/png", bytes: sentinelImage("x") },
      cookie,
    );
    expect(extNoToken.status).toBe(403);
    const rows = await admin.query("select count(*)::int as n from crm.contacts");
    expect(rows.rows[0].n).toBe(0);
  });

  it("a cross-site POST is refused by the Fetch-Metadata guard even with a session", async () => {
    const cookie = await signIn();
    const page = await fetch(`${base}/cards`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const csrf = csrfFrom(await page.text());
    const res = await formPost("/cards/create", { name: "Ana", _csrf: csrf }, cookie, {
      "sec-fetch-site": "cross-site",
    });
    expect(res.status).toBe(403);
    const rows = await admin.query("select count(*)::int as n from crm.contacts");
    expect(rows.rows[0].n).toBe(0);
  });
});

// ── C5: the feature is useful with NO extractor at all ───────────────────────────────────

describe("C5: empty extraction still yields a usable form; a contact can be made by hand", () => {
  it("the default stub extractor renders an EMPTY, editable confirmation form", async () => {
    const cookie = await signIn();
    const cardsPage = await fetch(`${base}/cards`, { headers: { cookie } });
    const csrf = csrfFrom(await cardsPage.text());
    const res = await multipartPost(
      "/cards/extract",
      { _csrf: csrf },
      {
        field: "photo",
        filename: "card.png",
        contentType: "image/png",
        bytes: sentinelImage("nothing-to-read"),
      },
      cookie,
    );
    expect(res.status).toBe(200);
    const fields = parseForm(await res.text(), "/cards/create");
    expect(fields).toMatchObject({ name: "", company: "", email: "", phone1: "", note: "" });
    expect(fields._csrf, "the confirmation form must carry its own CSRF token").toBeTruthy();
  });

  it("a contact created ENTIRELY by hand: manual form -> create -> created page shows the row", async () => {
    const cookie = await signIn();
    const manual = await fetch(`${base}/cards/manual`, { headers: { cookie } });
    expect(manual.status).toBe(200);
    const fields = parseForm(await manual.text(), "/cards/create");
    fields.name = "Ana Reyes";
    fields.email = "ana.reyes@example.com";
    fields.company = "Reyes Realty";
    fields.note = "wants a Makati condo";
    const created = await formPost("/cards/create", fields, cookie);
    expect(created.status).toBe(303);
    const location = created.headers.get("location") as string;
    expect(location).toMatch(/^\/cards\/created\/[0-9a-f-]{36}$/);
    await created.text(); // session-save sequencing (human-auth.test.ts idiom)

    const row = await admin.query(
      `select display_name, email_address, channel, source, source_detail, looking_for,
              next_due_at, follow_up_interval_days
         from crm.contacts`,
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].display_name).toBe("Ana Reyes");
    expect(row.rows[0].email_address).toBe("ana.reyes@example.com");
    expect(row.rows[0].channel).toBe("email");
    expect(row.rows[0].source).toBe("event");
    expect(row.rows[0].source_detail).toContain("Reyes Realty");
    expect(row.rows[0].looking_for).toBe("wants a Makati condo");
    // NULL, never the tenant default frozen in — intervals are HERS at due-computation
    // time (crm/src/due.ts doctrine).
    expect(row.rows[0].follow_up_interval_days).toBeNull();

    const page = await fetch(`${base}${location}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Ana Reyes");
    expect(html).toContain("ana.reyes@example.com");
    // The page shows the COMPUTED next_due_at read back from the row, not prose.
    const due = new Date(row.rows[0].next_due_at as Date).toISOString();
    expect(html).toContain(due);
  });
});

// ── C4: a captured contact is due NOW, by the loop's own definition of "due" ─────────────

describe("C4: a created contact is claimed by the REAL due-query on the next cycle", () => {
  it("claimDue (the proposer's own claim) picks the contact up immediately", async () => {
    const cookie = await signIn();
    const manual = await fetch(`${base}/cards/manual`, { headers: { cookie } });
    const fields = parseForm(await manual.text(), "/cards/create");
    fields.name = "Ben Santos";
    fields.email = "ben.santos@example.com";
    const created = await formPost("/cards/create", fields, cookie);
    expect(created.status).toBe(303);
    await created.text();
    const contactId = (created.headers.get("location") as string).split("/").pop() as string;

    // 🚨 THE ASSERTION IS THE REAL DUE-QUERY, run as the proposer's own role — not a
    // hand-rolled `next_due_at <= now()` comparison that could drift from the loop.
    //
    // The claim clock is "one second from now", i.e. THE NEXT CYCLE — which is the pin's
    // exact claim — not this same millisecond. Measured reason: the capture writes
    // `next_due_at = now()` on the DATABASE clock (intake.ts's own idiom) while claimDue
    // compares against an injected APP-clock timestamp, and this machine's Postgres
    // clock runs ~20ms ahead of process.hrtime's — a same-instant claim is therefore
    // clock-skew-flaky by construction. In production the proposer runs minutes later
    // and the skew is invisible.
    const claimed = await claimDue(crmPool, SEED_TENANT, 10, new Date(Date.now() + 1000));
    expect(claimed.map((c) => c.id)).toContain(contactId);
  });
});

// ── C3: what she saw and edited is what is stored — never the extractor's value ──────────

describe("C3: the contact is created from HER confirmed fields, not the extracted ones", () => {
  it("she edits the extracted email; the stored contact carries her value and the extractor's appears nowhere", async () => {
    const cookie = await signIn();
    provideCardExtractor(app, async () => ({
      name: "Carla Cruz",
      company: "Cruz Brokerage",
      email: "misread@example.com",
      phones: [],
      raw: "Carla Cruz — Cruz Brokerage — misread@example.com",
    }));
    const cardsPage = await fetch(`${base}/cards`, { headers: { cookie } });
    const csrf = csrfFrom(await cardsPage.text());
    const res = await multipartPost(
      "/cards/extract",
      { _csrf: csrf },
      { field: "photo", filename: "c.png", contentType: "image/png", bytes: sentinelImage("c3") },
      cookie,
    );
    expect(res.status).toBe(200);
    // The browser's view of the form — EVERY field, hidden ones included, so a mutation
    // that smuggles the extracted value through a hidden input is carried to /cards/create
    // exactly as a browser would carry it.
    const fields = parseForm(await res.text(), "/cards/create");
    expect(fields.email, "the form must pre-fill what was extracted").toBe(
      "misread@example.com",
    );
    fields.email = "carla.cruz@example.com"; // HER correction
    const created = await formPost("/cards/create", fields, cookie);
    expect(created.status).toBe(303);
    await created.text();

    const row = await admin.query(`select email_address from crm.contacts`);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].email_address).toBe("carla.cruz@example.com");
    // The extractor's misread must not survive ANYWHERE on the stored row.
    const leaked = await admin.query(
      `select count(*)::int as n from crm.contacts c where c::text like '%misread@example.com%'`,
    );
    expect(leaked.rows[0].n).toBe(0);
  });
});

// ── C6: a broken extractor costs her nothing but the pre-fill ────────────────────────────

describe("C6: an extractor that throws does not lose her work", () => {
  it("the page names the failure and still offers the manual form, which works", async () => {
    const cookie = await signIn();
    provideCardExtractor(app, async () => {
      throw new Error("vendor exploded: HTTP 500 from OCR endpoint");
    });
    const cardsPage = await fetch(`${base}/cards`, { headers: { cookie } });
    const csrf = csrfFrom(await cardsPage.text());
    const res = await multipartPost(
      "/cards/extract",
      { _csrf: csrf },
      { field: "photo", filename: "c.png", contentType: "image/png", bytes: sentinelImage("c6") },
      cookie,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // LOUD — a silent empty form would read as "the card was blank".
    expect(html).toContain("FAILED");
    expect(html).toContain("vendor exploded: HTTP 500 from OCR endpoint");
    const fields = parseForm(html, "/cards/create");
    fields.name = "Typed By Hand";
    fields.email = "hand@example.com";
    const created = await formPost("/cards/create", fields, cookie);
    expect(created.status).toBe(303);
    await created.text();
    const row = await admin.query(`select display_name from crm.contacts`);
    expect(row.rows[0].display_name).toBe("Typed By Hand");
  });
});

// ── C7: phones — E.164 in storage, unreadable surfaced, nothing guessed or dropped ───────

describe("C7: phone handling", () => {
  it("a valid PH number is stored as E.164 with her raw form byte-identical", async () => {
    const cookie = await signIn();
    const manual = await fetch(`${base}/cards/manual`, { headers: { cookie } });
    const fields = parseForm(await manual.text(), "/cards/create");
    fields.name = "Dio Ramos";
    fields.phone1 = "0917 123 4567";
    const created = await formPost("/cards/create", fields, cookie);
    expect(created.status).toBe(303);
    await created.text();
    const p = await admin.query(`select phone_e164, phone_raw, ordinal from crm.phone_numbers`);
    expect(p.rowCount).toBe(1);
    expect(p.rows[0].phone_e164).toBe("+639171234567");
    expect(p.rows[0].phone_raw).toBe("0917 123 4567");
    expect(p.rows[0].ordinal).toBe(0);
  });

  it("an unreadable number REFUSES the save with words, preserves her input, stores nothing", async () => {
    const cookie = await signIn();
    const manual = await fetch(`${base}/cards/manual`, { headers: { cookie } });
    const fields = parseForm(await manual.text(), "/cards/create");
    fields.name = "Eva Lim";
    fields.phone1 = "call me maybe";
    const res = await formPost("/cards/create", fields, cookie);
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("UNREADABLE");
    expect(html).toContain("could not read &quot;call me maybe&quot; as a phone number");
    // Her work survives the refusal: the re-rendered form still carries every value.
    const again = parseForm(html, "/cards/create");
    expect(again.name).toBe("Eva Lim");
    expect(again.phone1).toBe("call me maybe");
    const rows = await admin.query("select count(*)::int as n from crm.contacts");
    expect(rows.rows[0].n).toBe(0);
  });

  it("an EXTRACTED phone that does not parse is marked unreadable on the form, not dropped", async () => {
    const cookie = await signIn();
    provideCardExtractor(app, async () => ({
      name: null,
      company: null,
      email: null,
      phones: ["totally-not-a-number"],
      raw: null,
    }));
    const cardsPage = await fetch(`${base}/cards`, { headers: { cookie } });
    const csrf = csrfFrom(await cardsPage.text());
    const res = await multipartPost(
      "/cards/extract",
      { _csrf: csrf },
      { field: "photo", filename: "c.png", contentType: "image/png", bytes: sentinelImage("c7") },
      cookie,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // Preserved in the field for her to fix…
    const fields = parseForm(html, "/cards/create");
    expect(fields.phone1).toBe("totally-not-a-number");
    // …and NAMED as unreadable, never silently shown as if it were fine.
    expect(html).toContain("could not read &quot;totally-not-a-number&quot; as a phone number");
  });
});

// ── C8: extracted text is data, never markup ─────────────────────────────────────────────

describe("C8: XSS — extracted fields containing <script> render escaped", () => {
  it("a hostile card cannot script the approver's browser", async () => {
    const cookie = await signIn();
    provideCardExtractor(app, async () => ({
      name: "<script>alert(1)</script>",
      company: "'><img src=x onerror=alert(2)>",
      email: null,
      phones: [],
      raw: "<script>alert(3)</script>",
    }));
    const cardsPage = await fetch(`${base}/cards`, { headers: { cookie } });
    const csrf = csrfFrom(await cardsPage.text());
    const res = await multipartPost(
      "/cards/extract",
      { _csrf: csrf },
      { field: "photo", filename: "c.png", contentType: "image/png", bytes: sentinelImage("c8") },
      cookie,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // And the parsed form round-trips her-visible values intact (escaping, not mangling).
    const fields = parseForm(html, "/cards/create");
    expect(fields.name).toBe("<script>alert(1)</script>");
  });
});

// ── C9: upload limits — words, not silence; nothing created either way ───────────────────

describe("C9: a non-image and an oversize upload are both refused with clear words", () => {
  it("a PDF is refused as not-an-image and creates nothing", async () => {
    const cookie = await signIn();
    const cardsPage = await fetch(`${base}/cards`, { headers: { cookie } });
    const csrf = csrfFrom(await cardsPage.text());
    const res = await multipartPost(
      "/cards/extract",
      { _csrf: csrf },
      {
        field: "photo",
        filename: "card.pdf",
        contentType: "application/pdf",
        bytes: sentinelImage("c9-pdf"),
      },
      cookie,
    );
    expect(res.status).toBe(415);
    const html = await res.text();
    expect(html).toContain("not an image");
    expect(html).toContain("application/pdf");
    const rows = await admin.query("select count(*)::int as n from crm.contacts");
    expect(rows.rows[0].n).toBe(0);
  });

  it("an oversize photo is refused with the limit named and creates nothing", async () => {
    const cookie = await signIn();
    const cardsPage = await fetch(`${base}/cards`, { headers: { cookie } });
    const csrf = csrfFrom(await cardsPage.text());
    const res = await multipartPost(
      "/cards/extract",
      { _csrf: csrf },
      {
        field: "photo",
        filename: "huge.png",
        contentType: "image/png",
        bytes: Buffer.alloc(12 * 1024 * 1024, 0x41), // 12 MB > the 10 MB photo limit
      },
      cookie,
    );
    expect(res.status).toBe(413);
    const html = await res.text();
    expect(html).toContain("too large");
    expect(html).toContain("10 MB");
    const rows = await admin.query("select count(*)::int as n from crm.contacts");
    expect(rows.rows[0].n).toBe(0);
  });
});

// ── C2: THE PHOTO IS NEVER PERSISTED ─────────────────────────────────────────────────────

/** The sentinel in every byte-shape a lazy persistence path could give it: the ASCII
 *  itself (text/json columns), its hex (bytea rendered by `row::text`, or hex-encoded
 *  text), and its base64 in all three alignment phases (a whole-image base64 encodes the
 *  sentinel differently depending on its byte offset mod 3 — all three are covered, so
 *  embedding offset cannot hide it). */
function sentinelNeedles(sentinel: string): string[] {
  const b64Phase = (k: number): string =>
    Buffer.concat([Buffer.alloc(k, 0x2e), Buffer.from(sentinel, "ascii")])
      .toString("base64")
      .slice(4)
      .replace(/=+$/, "")
      .slice(0, -2);
  return [
    sentinel,
    Buffer.from(sentinel, "ascii").toString("hex"),
    b64Phase(0),
    b64Phase(1),
    b64Phase(2),
  ];
}

describe("C2: after a full extract→create cycle, the image exists nowhere", () => {
  // U4: the property is pinned PER AFFORDANCE — the camera path and the saved-photo path
  // each run the WHOLE cycle under the fs spies and the whole-database sentinel scan, so
  // a mutation that persists the photo on either path fails this pin.
  it.each(["camera", "saved-photo"] as const)(
    "via the %s affordance: no table holds the image bytes in any encoding, and no fs write API was touched",
    async (kind) => {
      const cookie = await signIn();
      const sentinel = `CARDSENTINEL${Math.random().toString(36).slice(2).toUpperCase()}`;
      const image = sentinelImage(sentinel);
      // An extractor that RETURNS fields (so the full confirm→create path runs) while the
      // image carries the sentinel — the realistic shape of a real vendor call.
      provideCardExtractor(app, async () => ({
        name: "Gina Tan",
        company: "Tan Estates",
        email: "gina@example.com",
        phones: ["0917 555 0000"],
        raw: "Gina Tan — Tan Estates",
      }));

      const cardsPage = await fetch(`${base}/cards`, { headers: { cookie } });
      const form = uploadForm(await cardsPage.text(), kind);

      // Every write-capable fs API watched across the WHOLE cycle. The spies wrap the real
      // implementations (nothing is stubbed out), so any legitimate write would both happen
      // AND be counted — the assertion below is that there were none at all.
      const spies = [
        vi.spyOn(fs, "writeFile"),
        vi.spyOn(fs, "writeFileSync"),
        vi.spyOn(fs, "appendFile"),
        vi.spyOn(fs, "appendFileSync"),
        vi.spyOn(fs, "createWriteStream"),
        vi.spyOn(fs, "open"),
        vi.spyOn(fs, "openSync"),
        vi.spyOn(fs.promises, "writeFile"),
        vi.spyOn(fs.promises, "appendFile"),
        vi.spyOn(fs.promises, "open"),
      ];

      const ext = await multipartPost(
        form.action,
        { _csrf: form.csrf },
        { field: "photo", filename: "card.png", contentType: "image/png", bytes: image },
        cookie,
      );
      expect(ext.status).toBe(200);
      const fields = parseForm(await ext.text(), "/cards/create");
      const created = await formPost("/cards/create", fields, cookie);
      expect(created.status).toBe(303);
      await created.text();

      const writes = spies.reduce((n, s) => n + s.mock.calls.length, 0);
      expect(writes, "no file write of ANY kind may happen during the capture cycle").toBe(0);

      // The database side: EVERY base table in the ephemeral database, every row cast to
      // text, hunted for the sentinel in every encoding. A mutation that stashes the image
      // in a payload column, a session row, or a new table is caught by construction.
      const tables = await admin.query<{ s: string; t: string }>(
        `select n.nspname as s, c.relname as t
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema')`,
      );
      expect(tables.rowCount, "the scan must actually see the schema").toBeGreaterThan(10);
      for (const { s, t } of tables.rows) {
        for (const needle of sentinelNeedles(sentinel)) {
          const q = await admin.query(
            `select count(*)::int as n from "${s}"."${t}" x where x::text ilike '%' || $1 || '%'`,
            [needle],
          );
          expect(
            q.rows[0].n,
            `image bytes (needle ${needle.slice(0, 16)}…) found in ${s}.${t}`,
          ).toBe(0);
        }
      }
      // And the cycle actually completed — this scan ran against a REAL capture.
      const row = await admin.query(`select display_name from crm.contacts`);
      expect(row.rows[0].display_name).toBe("Gina Tan");
    },
  );
});

// ── The vendor seam's construction contract ──────────────────────────────────────────────

describe("the extraction seam refuses to half-exist", () => {
  it("vendorExtractCard THROWS AT CONSTRUCTION when unconfigured, naming what is missing", () => {
    expect(() => vendorExtractCard({})).toThrow(/missing config vendor, apiKey, endpoint/);
    expect(() => vendorExtractCard({ vendor: "x", apiKey: "k" })).toThrow(/endpoint/);
  });

  it("a configured adapter constructs, then refuses to run: no vendor has been chosen", async () => {
    const fn = vendorExtractCard({ vendor: "x", apiKey: "k", endpoint: "https://ocr.example" });
    await expect(fn({ bytes: new Uint8Array(0), mimeType: "image/png" })).rejects.toThrow(
      /not implemented/,
    );
  });
});

// ── U1/U2/U3/U5: the saved-photo affordance — explicit, same pipeline, same defences ─────
//
// MDN documents `capture` as a HINT (developer.mozilla.org, read 2026-08-20): a browser
// MAY still offer the gallery behind a capture-carrying input. The owner's use case — a
// card photographed at lunch, uploaded that evening — must not depend on that, so the
// choice is EXPLICIT on the page: one input that opens the camera, one that opens the
// picker. ONE pipeline behind both: the tests below derive each form's action from the
// page itself, so a mutation that gives the saved path its own route goes red here.

describe("U1: /cards offers BOTH a take-a-photo-now and a choose-a-saved-photo input", () => {
  it("renders one file input WITH capture='environment' and one WITHOUT any capture attribute", async () => {
    const cookie = await signIn();
    const res = await fetch(`${base}/cards`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    const fileInputs = [...html.matchAll(/<input[^>]*type='file'[^>]*>/g)].map((m) => m[0]);
    const camera = fileInputs.filter((i) => i.includes("capture='environment'"));
    const saved = fileInputs.filter((i) => !/\scapture=/.test(i));
    expect(camera, "the take-a-photo-now input must keep capture='environment'").toHaveLength(1);
    expect(saved, "a saved-photo input must exist WITHOUT a capture attribute").toHaveLength(1);
    for (const i of fileInputs) {
      expect(i, "both inputs are image uploads under the one field name").toContain(
        "name='photo'",
      );
      expect(i).toContain("accept='image/*'");
    }
  });
});

describe("U2: the saved-photo path is the SAME flow end to end", () => {
  it("an upload through the no-capture form reaches the extraction seam, renders the confirmation form, and creates the contact", async () => {
    const cookie = await signIn();
    provideCardExtractor(app, async () => ({
      name: "Lena Uy",
      company: "Uy Holdings",
      email: "lena.uy@example.com",
      phones: [],
      raw: "Lena Uy — Uy Holdings",
    }));
    const cardsPage = await fetch(`${base}/cards`, { headers: { cookie } });
    const form = uploadForm(await cardsPage.text(), "saved-photo");
    const ext = await multipartPost(
      form.action,
      { _csrf: form.csrf },
      {
        field: "photo",
        filename: "lunch-card.jpg",
        contentType: "image/jpeg",
        bytes: sentinelImage("u2-saved-later"),
      },
      cookie,
    );
    expect(ext.status, "the saved-photo form must land on the working extract flow").toBe(200);
    const fields = parseForm(await ext.text(), "/cards/create");
    expect(fields.name, "the extraction seam ran for the saved-photo upload").toBe("Lena Uy");
    expect(fields.email).toBe("lena.uy@example.com");
    const created = await formPost("/cards/create", fields, cookie);
    expect(created.status).toBe(303);
    await created.text();
    const row = await admin.query(`select display_name, email_address from crm.contacts`);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].display_name).toBe("Lena Uy");
    expect(row.rows[0].email_address).toBe("lena.uy@example.com");
  });
});

describe("U3: both affordances land on the SAME limits", () => {
  it("an oversize photo and a non-image are refused identically whichever form was used", async () => {
    const cookie = await signIn();
    const html = await (await fetch(`${base}/cards`, { headers: { cookie } })).text();
    const outcomes: Record<string, { over: number; overHtml: string; pdf: number; pdfHtml: string }> =
      {};
    for (const kind of ["camera", "saved-photo"] as const) {
      const form = uploadForm(html, kind);
      const over = await multipartPost(
        form.action,
        { _csrf: form.csrf },
        {
          field: "photo",
          filename: "huge.png",
          contentType: "image/png",
          bytes: Buffer.alloc(12 * 1024 * 1024, 0x41), // 12 MB > the 10 MB photo limit
        },
        cookie,
      );
      const pdf = await multipartPost(
        form.action,
        { _csrf: form.csrf },
        {
          field: "photo",
          filename: "card.pdf",
          contentType: "application/pdf",
          bytes: sentinelImage(`u3-${kind}`),
        },
        cookie,
      );
      outcomes[kind] = {
        over: over.status,
        overHtml: await over.text(),
        pdf: pdf.status,
        pdfHtml: await pdf.text(),
      };
    }
    for (const kind of ["camera", "saved-photo"] as const) {
      expect(outcomes[kind].over, `${kind}: oversize refusal`).toBe(413);
      expect(outcomes[kind].overHtml).toContain("10 MB");
      expect(outcomes[kind].pdf, `${kind}: non-image refusal`).toBe(415);
      expect(outcomes[kind].pdfHtml).toContain("not an image");
    }
    const rows = await admin.query("select count(*)::int as n from crm.contacts");
    expect(rows.rows[0].n, "neither refused upload may create anything").toBe(0);
  });
});

describe("U5: both affordances stay behind auth and CSRF", () => {
  it("the page holding both inputs bounces the signed-out to /login", async () => {
    const res = await fetch(`${base}/cards`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("both forms carry the session's CSRF field, and a saved-photo post without it is 403", async () => {
    const cookie = await signIn();
    const html = await (await fetch(`${base}/cards`, { headers: { cookie } })).text();
    for (const kind of ["camera", "saved-photo"] as const) {
      expect(uploadForm(html, kind).csrf, `the ${kind} form must carry _csrf`).toBeTruthy();
    }
    const form = uploadForm(html, "saved-photo");
    const res = await multipartPost(
      form.action,
      {}, // no _csrf field at all
      { field: "photo", filename: "c.png", contentType: "image/png", bytes: sentinelImage("u5") },
      cookie,
    );
    expect(res.status).toBe(403);
    const rows = await admin.query("select count(*)::int as n from crm.contacts");
    expect(rows.rows[0].n).toBe(0);
  });
});
