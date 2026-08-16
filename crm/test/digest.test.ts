// Daily-digest pins — `runDailyDigest` on a real ephemeral database, under the REAL
// service roles (`switchboard_crm` for the crm side, `switchboard_approval` for the
// approval side), so every grant migration 020 claims is exercised rather than assumed.
// The only fake is the sender, which records every message and never opens a socket.
//
// 🚨 THE PROPERTIES UNDER PIN, in order of what they cost when lost:
//   1. ONE CLOCK AUTHORITY. The local date, the 07:00 gate and the already-sent check are
//      Postgres, in one statement, against `outreach_settings.timezone`. The named trap:
//      07:00 Manila is 23:00 UTC the PREVIOUS day, so a JS-computed date key sends at
//      07:00 Manila AND AGAIN at 08:00 Manila when UTC midnight flips the key.
//   2. Send-once-per-local-date survives a restart — the state is `crm.digest_sends`, not
//      process memory.
//   3. RECORD AFTER SEND: a failing send leaves NO row and the next tick retries.
//   4. The subject line carries the entire state, in both the something and nothing cases.
//   5. "Since the last digest" is the previous row's `sent_at`, never a date boundary — a
//      date boundary silently skips the midnight-to-07:00 gap.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { freshCrmDb, seedContact, seedSettings } from "./helpers/crmdb.js";
import { payloadHash } from "../../approval/src/canonical.js";
import { findStuckExecutions } from "../../approval/src/execute.js";
import { reconcile } from "../src/reconcile.js";
import type { EmailMessage, SendEmail } from "../src/email-transport.js";
import { runDailyDigest, type DigestDeps } from "../src/digest.js";

let admin: pg.Pool;
let crm: pg.Pool;
let approval: pg.Pool;
let dbUrl: string;
let cleanup: () => Promise<void>;

const QUEUE_URL = "https://approve.example.test/queue";

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  dbUrl = db.url;
  cleanup = db.cleanup;
  // The approval-side pool, as the role the executor loop actually holds. A digest query
  // that only works as the owner would be testing a universe the loop cannot reach.
  approval = rolePool(dbUrl, "switchboard_approval");
  // The recipient list is active `approval.users` rows — one approver, like the shipped
  // single-broker deployment.
  await admin.query(`insert into approval.users (email) values ('broker@example.com')`);
});

afterAll(async () => {
  await approval.end().catch(() => {});
  await cleanup();
});

function rolePool(url: string, role: string): pg.Pool {
  const u = new URL(url);
  u.username = role;
  u.password = role;
  const p = new pg.Pool({ connectionString: u.toString(), max: 4 });
  p.on("error", () => {});
  return p;
}

function recordingSender(log: EmailMessage[]): SendEmail {
  return async (m) => {
    log.push(m);
    return { messageId: "<digest@stub>", accepted: [m.to], rejected: [], response: "250 ok" };
  };
}

function mkDeps(
  tenant: string,
  log: EmailMessage[],
  nowIso: string,
  over: Partial<DigestDeps> = {},
): DigestDeps {
  return {
    approvalDb: approval,
    crmDb: crm,
    tenantId: tenant,
    sendEmail: recordingSender(log),
    queueUrl: QUEUE_URL,
    findStuckExecutions,
    now: () => new Date(nowIso),
    ...over,
  };
}

async function newTenant(): Promise<string> {
  const t = randomUUID();
  await seedSettings(admin, { tenant: t, timezone: "Asia/Manila" });
  return t;
}

async function digestRows(tenant: string): Promise<Array<{ d: string }>> {
  const r = await crm.query<{ d: string }>(
    `select digest_date::text as d from crm.digest_sends where tenant_id = $1 order by d`,
    [tenant],
  );
  return r.rows;
}

describe("daily digest", () => {
  // ── PIN 1: the clock authority. RUN 2026-08-16: mutated `runDailyDigest` to compute the
  // key in JS (`const localDate = (deps.now ? deps.now() : new Date()).toISOString()
  // .slice(0, 10)` after the gate — the exact trap under pin) — RED, exit 1:
  //   AssertionError: expected '2026-08-15' to be '2026-08-16' // Object.is equality
  // the digest keyed on the UTC date of the previous day, which is what re-sends at 08:00
  // Manila when UTC midnight flips the key. Restored, green.
  it("keys on the LOCAL date computed by Postgres — 07:00 Manila sends once, and UTC midnight does not re-send", async () => {
    const t = await newTenant();
    const log: EmailMessage[] = [];

    // 06:30 Manila (22:30 UTC the previous day): before the gate. Nothing sends.
    const early = await runDailyDigest(mkDeps(t, log, "2026-08-15T22:30:00Z"));
    expect(early.sent).toBe(false);
    expect(log).toHaveLength(0);

    // 07:30 Manila on 2026-08-16 — which is 23:30 UTC on 2026-08-15. The key must be the
    // MANILA date. A JS `toISOString().slice(0, 10)` here yields 2026-08-15: the mutation
    // this pin exists to catch.
    const sent = await runDailyDigest(mkDeps(t, log, "2026-08-15T23:30:00Z"));
    expect(sent.sent).toBe(true);
    if (sent.sent) expect(sent.localDate).toBe("2026-08-16");
    expect(await digestRows(t)).toEqual([{ d: "2026-08-16" }]);
    expect(log).toHaveLength(1);

    // 08:30 Manila, same local date — but UTC midnight has now flipped (00:30 UTC on the
    // 16th). A UTC-keyed implementation sends AGAIN here. Same local date: no-op.
    const again = await runDailyDigest(mkDeps(t, log, "2026-08-16T00:30:00Z"));
    expect(again.sent).toBe(false);
    expect(log).toHaveLength(1);
    expect(await digestRows(t)).toEqual([{ d: "2026-08-16" }]);

    // The next Manila morning sends the next edition.
    const nextDay = await runDailyDigest(mkDeps(t, log, "2026-08-16T23:05:00Z"));
    expect(nextDay.sent).toBe(true);
    if (nextDay.sent) expect(nextDay.localDate).toBe("2026-08-17");
    expect(log).toHaveLength(2);
  });

  // ── PIN 2. RUN 2026-08-16: mutated the gate statement by deleting the
  // `and not exists (… digest_date = …)` clause — RED, exit 1:
  //   AssertionError: expected true to be false // Object.is equality
  // at the `second.sent` assertion: the post-"restart" run re-sent the same local date.
  // Restored, green.
  it("sends once per local date across a simulated restart — the state is the table, not the process", async () => {
    const t = await newTenant();
    const log: EmailMessage[] = [];
    const first = await runDailyDigest(mkDeps(t, log, "2026-08-20T01:00:00Z")); // Manila 09:00
    expect(first.sent).toBe(true);

    // "Restart": brand-new pools, brand-new deps, nothing shared but the database.
    const crm2 = rolePool(dbUrl, "switchboard_crm");
    const approval2 = rolePool(dbUrl, "switchboard_approval");
    try {
      const log2: EmailMessage[] = [];
      const second = await runDailyDigest(
        mkDeps(t, log2, "2026-08-20T03:00:00Z", { crmDb: crm2, approvalDb: approval2 }),
      );
      expect(second.sent).toBe(false);
      expect(log2).toHaveLength(0);
      expect(await digestRows(t)).toEqual([{ d: "2026-08-20" }]);
    } finally {
      await crm2.end().catch(() => {});
      await approval2.end().catch(() => {});
    }
  });

  // ── PIN 3. RUN 2026-08-16: mutated `runDailyDigest` to insert the `digest_sends` row
  // BEFORE the send loop — RED, exit 1:
  //   AssertionError: expected [ { d: '2026-08-21' } ] to deeply equal []
  // (the failed send left a row, so the retry would be refused: a digest marked sent that
  // nobody received — fails toward silence). Restored, green.
  it("records AFTER a successful send — a failing send leaves no row and the next tick retries", async () => {
    const t = await newTenant();
    const down: SendEmail = async () => {
      throw new Error("smtp relay down");
    };
    await expect(
      runDailyDigest(mkDeps(t, [], "2026-08-21T01:00:00Z", { sendEmail: down })),
    ).rejects.toThrow(/reached nobody.*SWITCHBOARD_EMAIL_ALLOWLIST/s);
    expect(await digestRows(t)).toEqual([]); // no row: the next tick retries (toward noise)

    // The relay comes back; the same tick logic now succeeds and records.
    const log: EmailMessage[] = [];
    const retry = await runDailyDigest(mkDeps(t, log, "2026-08-21T01:05:00Z"));
    expect(retry.sent).toBe(true);
    expect(log).toHaveLength(1);
    expect(await digestRows(t)).toEqual([{ d: "2026-08-21" }]);
  });

  // ── PIN 4. RUN 2026-08-16, two mutations, each observed red on its own:
  //   (a) `formatDigestSubject` → `return "Daily digest";` — RED, exit 1:
  //       AssertionError: expected 'Daily digest' to be '3 approvals waiting — 1 expires
  //       within 24h, 3 blocked' // Object.is equality
  //   (b) only the nothing-branch → `"Daily digest"` — RED, exit 1:
  //       AssertionError: expected 'Daily digest' to be 'Nothing needs you today'
  //   (c) blocked query narrowed to `= 'no_email_address'` (the "not just missing email"
  //       requirement) — RED, exit 1: Received: "… 1 blocked" vs Expected "… 3 blocked"
  // Restored, green.
  it("carries the entire state in the subject line — and says so when there is none", async () => {
    const t = await newTenant();
    const instant = "2026-08-22T01:00:00Z"; // Manila 09:00
    // Three pending proposals, one of them expiring within 24 hours of the instant.
    for (const hours of [72, 72, 2]) {
      const payload = { to: "x@example.com" };
      await admin.query(
        `insert into approval.proposals
           (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash, expires_at)
         values ($1, $2, 'send_email', $3::jsonb, 'digest pin', $4,
                 $5::timestamptz + make_interval(hours => $6))`,
        [t, `digest-${randomUUID()}`, JSON.stringify(payload), payloadHash(payload), instant, hours],
      );
    }
    // Blocked follow-ups in ALL THREE reasons — not just missing email.
    for (const reason of ["no_email_address", "no_phone_number", "no_question_set"]) {
      const c = await seedContact(admin, { tenant: t, displayName: `Blocked ${reason}` });
      await admin.query(
        `insert into crm.follow_ups (contact_id, due_date, blocked_reason)
         values ($1, current_date, $2)`,
        [c, reason],
      );
    }

    const log: EmailMessage[] = [];
    const run = await runDailyDigest(mkDeps(t, log, instant));
    expect(run.sent).toBe(true);
    if (run.sent) {
      expect(run.subject).toBe("3 approvals waiting — 1 expires within 24h, 3 blocked");
      expect(run.counts.blocked).toEqual([
        { reason: "no_email_address", count: 1 },
        { reason: "no_phone_number", count: 1 },
        { reason: "no_question_set", count: 1 },
      ]);
    }
    expect(log).toHaveLength(1);
    expect(log[0].subject).toBe("3 approvals waiting — 1 expires within 24h, 3 blocked");
    expect(log[0].to).toBe("broker@example.com");
    expect(log[0].body).toContain(QUEUE_URL);
    expect(log[0].body).toContain("Bounces recorded since the last digest: 0");

    // The nothing case STILL SENDS — silence must stay distinguishable from death — and
    // the subject says exactly that.
    const tQuiet = await newTenant();
    const quietLog: EmailMessage[] = [];
    const quiet = await runDailyDigest(mkDeps(tQuiet, quietLog, instant));
    expect(quiet.sent).toBe(true);
    if (quiet.sent) expect(quiet.subject).toBe("Nothing needs you today");
    expect(quietLog).toHaveLength(1);
  });

  // ── PIN 5. RUN 2026-08-16: mutated the gate's window from the previous row's `sent_at`
  // to the LOCAL-MIDNIGHT date boundary
  // (`((((t.instant at time zone s.timezone)::date)::timestamp) at time zone s.timezone)`)
  // — RED, exit 1:
  //   AssertionError: expected +0 to be 1 // Object.is equality   (newContacts)
  // the 09:00-yesterday contact fell in the silently-skipped pre-boundary gap. Restored,
  // green.
  it("windows 'since the last digest' on the previous row's sent_at, not a date boundary", async () => {
    const t = await newTenant();
    // Yesterday's digest: local date 2026-08-19, sent at 07:05 Manila (23:05Z on the 18th).
    await crm.query(
      `insert into crm.digest_sends (tenant_id, digest_date, sent_at)
       values ($1, '2026-08-19', '2026-08-18T23:05:00Z')`,
      [t],
    );
    // IN the window: created 09:00 Manila on the 19th — after sent_at, but BEFORE local
    // midnight of the 20th, which is what a date-boundary window would use.
    const inWindow = await seedContact(admin, { tenant: t, displayName: "In window" });
    await admin.query(`update crm.contacts set created_at = '2026-08-19T01:00:00Z' where id = $1`, [inWindow]);
    // OUT of the window: created 04:00 Manila on the 19th, before yesterday's send.
    const outOfWindow = await seedContact(admin, { tenant: t, displayName: "Before last digest" });
    await admin.query(`update crm.contacts set created_at = '2026-08-18T20:00:00Z' where id = $1`, [outOfWindow]);
    // Bounces recorded: one in the window, one before it — same boundary.
    await admin.query(
      `insert into crm.touches (contact_id, channel, disposition, occurred_at)
       values ($1, 'email', 'bounced', '2026-08-19T01:10:00Z'),
              ($1, 'email', 'bounced', '2026-08-18T20:10:00Z')`,
      [inWindow],
    );
    // Expired unseen: one whose expiry fell in the window, one before it.
    for (const at of ["2026-08-19T01:20:00Z", "2026-08-18T20:20:00Z"]) {
      const payload = { to: "x@example.com" };
      const p = await admin.query<{ id: string }>(
        `insert into approval.proposals
           (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash, expires_at)
         values ($1, $2, 'send_email', $3::jsonb, 'digest pin', $4, $5)
         returning id`,
        [t, `digest-${randomUUID()}`, JSON.stringify(payload), payloadHash(payload), at],
      );
      await admin.query(`update approval.proposals set state = 'expired' where id = $1`, [p.rows[0].id]);
    }

    const log: EmailMessage[] = [];
    const run = await runDailyDigest(mkDeps(t, log, "2026-08-20T01:00:00Z")); // Manila 09:00 on the 20th
    expect(run.sent).toBe(true);
    if (run.sent) {
      expect(run.counts.newContacts).toBe(1);
      expect(run.counts.bouncesRecorded).toBe(1);
      expect(run.counts.expiredUnseen).toBe(1);
      expect(run.subject).toBe("1 expired unseen");
    }
    expect(log[0].body).toContain("since the last digest at 2026-08-18T23:05:00.000Z");

    // The FIRST digest's window is explicitly 24 hours — not all history.
    const tFirst = await newTenant();
    const recent = await seedContact(admin, { tenant: tFirst, displayName: "Recent" });
    await admin.query(`update crm.contacts set created_at = '2026-08-19T23:00:00Z' where id = $1`, [recent]);
    const ancient = await seedContact(admin, { tenant: tFirst, displayName: "Ancient" });
    await admin.query(`update crm.contacts set created_at = '2026-08-18T19:00:00Z' where id = $1`, [ancient]);
    const firstLog: EmailMessage[] = [];
    const first = await runDailyDigest(mkDeps(tFirst, firstLog, "2026-08-20T01:00:00Z"));
    expect(first.sent).toBe(true);
    if (first.sent) expect(first.counts.newContacts).toBe(1); // 30h-old contact excluded
    expect(firstLog[0].body).toContain("first digest — covering the last 24 hours");
  });

  // ── The owner-side watchdog for the watchdog. RUN 2026-08-16: mutated the reconcile
  // query by deleting its `not exists` clause — RED, exit 1:
  //   AssertionError: expected [ { …(2) } ] to deeply equal []
  //   + [ { "localDate": "2026-08-17", "tenantId": "93f42dc6-…" } ]
  // (the tenant stayed listed after its digest was recorded). Restored, green.
  it("reconcile lists a tenant with no digest recorded for today's local date, and drops it once recorded", async () => {
    const t = await newTenant();
    // digestDueLocalTime "00:00" makes the grace gate always-passed, so this pin does not
    // inherit the suite's known clock-windowed failure class.
    const before = await reconcile(admin, { digestDueLocalTime: "00:00" });
    expect(before.digestMissing.filter((d) => d.tenantId === t)).toHaveLength(1);

    // Record today's digest for this tenant — today COMPUTED BY POSTGRES in the tenant's
    // timezone, the same clock authority the phase itself uses.
    await admin.query(
      `insert into crm.digest_sends (tenant_id, digest_date)
       values ($1, (now() at time zone 'Asia/Manila')::date)`,
      [t],
    );
    const after = await reconcile(admin, { digestDueLocalTime: "00:00" });
    expect(after.digestMissing.filter((d) => d.tenantId === t)).toEqual([]);
  });
});
