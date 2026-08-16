// A0b — magic-link token semantics: hashed at rest, single-use, short expiry,
// rate-limited per account, one audit row per login. Every property here is asserted at
// the DATABASE, through the same functions the routes call, on the approval role's own
// connection — never by trusting what a page said.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { freshTestDb } from "../../ingest/test/helpers/testdb.js";
import {
  consumeLoginToken,
  generateLoginToken,
  hashLoginToken,
  recordLogin,
  requestLoginLink,
  type SendLoginLink,
} from "../src/login.js";
import { LOGIN_REQUEST_RATE_LIMIT } from "../src/config.js";

let admin: pg.Pool;
let approvalPool: pg.Pool;
let cleanup: () => Promise<void>;

const PUBLIC_URL = "https://approvals.example.test";

beforeAll(async () => {
  const r = await freshTestDb();
  admin = r.pool;
  cleanup = r.cleanup;
  const u = new URL(r.url);
  u.username = "switchboard_approval";
  u.password = "switchboard_approval";
  approvalPool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  approvalPool.on("error", () => {});
}, 60_000);

afterEach(async () => {
  await admin.query("delete from approval_auth.login_audit");
  await admin.query("delete from approval_auth.login_tokens");
  await admin.query("delete from approval.users");
});

afterAll(async () => {
  if (approvalPool) await approvalPool.end().catch(() => {});
  if (cleanup) await cleanup();
});

async function seedUser(email?: string): Promise<{ id: string; email: string }> {
  const addr = email ?? `broker-${Math.random().toString(36).slice(2)}@example.com`;
  const r = await admin.query(`insert into approval.users (email) values ($1) returning id`, [
    addr,
  ]);
  return { id: r.rows[0].id as string, email: addr };
}

/** A sender that records instead of sending — the seam main.ts fills with Postmark. */
function captureSender(): { send: SendLoginLink; sent: Array<{ to: string; url: string }> } {
  const sent: Array<{ to: string; url: string }> = [];
  return {
    sent,
    send: async (to, url) => {
      sent.push({ to, url });
    },
  };
}

const tokenFromUrl = (url: string): string =>
  new URL(url).searchParams.get("token") ?? "";

describe("A0b: requesting a link", () => {
  it("stores ONLY the hash — the raw token appears in the emailed link and nowhere in the database", async () => {
    // mutation: store `raw` instead of `hashLoginToken(raw)` in requestLoginLink's
    //           INSERT -> reds. RUN ✅ 2026-08-15 — observed: AssertionError: expected
    //           'YihvwJDumt8s6-UFoKBJNMocC9EC4ZgzTw75g…' not to be the same string —
    //           i.e. token_hash EQUALLED the raw emailed token, the exact at-rest leak
    //           this pin exists for. Restored, green (10).
    const user = await seedUser();
    const { send, sent } = captureSender();
    const outcome = await requestLoginLink(approvalPool, user.email, PUBLIC_URL, send);
    expect(outcome).toEqual({ kind: "sent", userId: user.id });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(user.email);
    expect(sent[0].url.startsWith(`${PUBLIC_URL}/login/consume?token=`)).toBe(true);

    const raw = tokenFromUrl(sent[0].url);
    expect(raw.length).toBeGreaterThanOrEqual(43); // 32 CSPRNG bytes, base64url
    const row = await admin.query(`select token_hash, used_at from approval_auth.login_tokens`);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].token_hash).not.toBe(raw);
    expect(row.rows[0].token_hash).toBe(hashLoginToken(raw));
    expect(row.rows[0].used_at).toBeNull();
  });

  it("an unknown address writes nothing and sends nothing — and reports it only to the caller's log", async () => {
    const { send, sent } = captureSender();
    const outcome = await requestLoginLink(approvalPool, "nobody@example.com", PUBLIC_URL, send);
    expect(outcome).toEqual({ kind: "unknown-address" });
    expect(sent).toHaveLength(0);
    const rows = await admin.query(`select count(*)::int as n from approval_auth.login_tokens`);
    expect(rows.rows[0].n).toBe(0);
  });

  it("a DISABLED approver is indistinguishable from an unknown address", async () => {
    const user = await seedUser();
    await admin.query(`update approval.users set disabled_at = now() where id = $1`, [user.id]);
    const { send, sent } = captureSender();
    const outcome = await requestLoginLink(approvalPool, user.email, PUBLIC_URL, send);
    expect(outcome).toEqual({ kind: "unknown-address" });
    expect(sent).toHaveLength(0);
  });

  it("email resolution is EXACT byte equality — a case-variant address does not resolve (015's warning, inherited)", async () => {
    const user = await seedUser(`Broker-${Math.random().toString(36).slice(2)}@example.com`);
    const { send, sent } = captureSender();
    const outcome = await requestLoginLink(
      approvalPool,
      user.email.toLowerCase(),
      PUBLIC_URL,
      send,
    );
    expect(outcome).toEqual({ kind: "unknown-address" });
    expect(sent).toHaveLength(0);
  });

  it(`rate-limits per account: request ${LOGIN_REQUEST_RATE_LIMIT + 1} in one window, the last sends nothing`, async () => {
    // mutation: delete the `recent.rows[0].n >= LOGIN_REQUEST_RATE_LIMIT` early-return
    //           from requestLoginLink -> reds. RUN ✅ 2026-08-15 — observed:
    //           AssertionError: expected { kind: 'sent', …(1) } to deeply equal
    //           { kind: 'rate-limited', …(1) } — the 6th request sent anyway. Restored,
    //           green (10).
    const user = await seedUser();
    const { send, sent } = captureSender();
    for (let i = 0; i < LOGIN_REQUEST_RATE_LIMIT; i++) {
      const o = await requestLoginLink(approvalPool, user.email, PUBLIC_URL, send);
      expect(o.kind).toBe("sent");
    }
    const refused = await requestLoginLink(approvalPool, user.email, PUBLIC_URL, send);
    expect(refused).toEqual({ kind: "rate-limited", userId: user.id });
    expect(sent).toHaveLength(LOGIN_REQUEST_RATE_LIMIT);
    const rows = await admin.query(`select count(*)::int as n from approval_auth.login_tokens`);
    expect(rows.rows[0].n).toBe(LOGIN_REQUEST_RATE_LIMIT);
    // ...and it is PER ACCOUNT: a different approver is not collateral damage.
    const other = await seedUser();
    const o = await requestLoginLink(approvalPool, other.email, PUBLIC_URL, send);
    expect(o.kind).toBe("sent");
  });
});

describe("A0b: consuming a link", () => {
  async function mintFor(email: string): Promise<string> {
    const { send, sent } = captureSender();
    const o = await requestLoginLink(approvalPool, email, PUBLIC_URL, send);
    expect(o.kind).toBe("sent");
    return tokenFromUrl(sent[0].url);
  }

  it("a live token consumes ONCE; the same token a second time is null", async () => {
    // mutation: drop `and t.used_at is null` from consumeLoginToken's UPDATE -> the
    //           second consume succeeds and this reds. RUN ✅ 2026-08-16 — observed:
    //           AssertionError: expected { …(2) } to be null — the replayed token
    //           consumed again. Restored, green (10).
    const user = await seedUser();
    const raw = await mintFor(user.email);
    const first = await consumeLoginToken(approvalPool, raw);
    expect(first).not.toBeNull();
    expect(first!.userId).toBe(user.id);
    const used = await admin.query(`select used_at from approval_auth.login_tokens`);
    expect(used.rows[0].used_at).not.toBeNull();
    expect(await consumeLoginToken(approvalPool, raw)).toBeNull();
  });

  it("an EXPIRED token is refused", async () => {
    const user = await seedUser();
    const raw = await mintFor(user.email);
    await admin.query(`update approval_auth.login_tokens set expires_at = now() - interval '1 second'`);
    expect(await consumeLoginToken(approvalPool, raw)).toBeNull();
  });

  it("a TAMPERED token is refused — one flipped character misses the hash", async () => {
    const user = await seedUser();
    const raw = await mintFor(user.email);
    const tampered = (raw[0] === "A" ? "B" : "A") + raw.slice(1);
    expect(await consumeLoginToken(approvalPool, tampered)).toBeNull();
    // ...and a syntactically fine but never-issued token likewise.
    expect(await consumeLoginToken(approvalPool, generateLoginToken())).toBeNull();
  });

  it("a token minted for a user DISABLED afterwards dies immediately — no 15-minute grace", async () => {
    const user = await seedUser();
    const raw = await mintFor(user.email);
    await admin.query(`update approval.users set disabled_at = now() where id = $1`, [user.id]);
    expect(await consumeLoginToken(approvalPool, raw)).toBeNull();
  });

  it("recordLogin writes exactly one append-only audit row naming user and token", async () => {
    const user = await seedUser();
    const raw = await mintFor(user.email);
    const consumed = await consumeLoginToken(approvalPool, raw);
    await recordLogin(approvalPool, consumed!);
    const audit = await admin.query(
      `select user_id, token_id from approval_auth.login_audit`,
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].user_id).toBe(user.id);
    expect(audit.rows[0].token_id).toBe(consumed!.tokenId);
  });
});
