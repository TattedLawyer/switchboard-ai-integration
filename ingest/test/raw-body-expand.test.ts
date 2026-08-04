// Task A1 (Phase 2b) — raw_body expand phase (2b-D4) + quarantine replay accounting (C4)
// + FOR ROLE default-privilege correction (C2), all carried by migration 007.
//
// The claim under test: every door into raw.raw_events preserves the exact wire bytes it
// HAS — and never fabricates bytes it doesn't. Webhook doors (direct and queue-mediated)
// hold the request text and must store it byte-identically; the legacy poll door parses a
// page as a unit, so per-event wire bytes do not exist there and raw_body must be NULL,
// not a re-serialization passed off as wire bytes. Alongside: replaying a quarantined row
// must leave a trace (attempts / last_attempt_at), and the 007 migration must scope its
// default-privilege grant to an explicit target role so a split-role deploy still grants
// the agent SELECT on future marts (KNOWN-ISSUES: "target-role scoping is explicit").
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp } from "../src/server.js";
import type { SourceEvent } from "../src/server.js";
import type { Source } from "../src/sources.js";
import { signBody } from "../src/hmac.js";
import { createQueue, enqueueEvent, startWorker } from "../src/queue.js";
import { pollOnce } from "../src/backfill.js";
import { quarantineEvent, replayQuarantined, replayAllQuarantined } from "../src/quarantine.js";
import { ingestEvent, DEFAULT_TENANT_ID } from "../src/ingest-event.js";
import { createBillingApp } from "../../mocks/billing/src/server.js";

let pool: pg.Pool;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ pool, cleanup } = await freshTestDb());
});
afterEach(async () => {
  await cleanup();
});

// Deliberately NON-canonical JSON: odd spacing, a newline, key order that JSON.stringify of
// the parsed object would never reproduce. If raw_body were quietly re-serialized instead of
// stored from the wire, byte-identity against THIS text is what catches it.
const wireFor = (id: string): string =>
  `{ "event_id": "${id}",\n  "event_type":"company.updated" ,  "occurred_at": "${new Date().toISOString()}", "data": { "id": "DEMO-C-0001",   "name": "DEMO Spaced" } }`;

const postSigned = async (
  app: ReturnType<typeof createIngestApp>,
  source: string,
  body: string,
): Promise<Response> => {
  const srv = app.listen(0);
  const port = (srv.address() as { port: number }).port;
  try {
    return await fetch(`http://127.0.0.1:${port}/webhooks/${source}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-switchboard-signature": signBody(body, `demo-secret-${source}`),
      },
      body,
    });
  } finally {
    srv.close();
  }
};

// Bounded poll helper (house pattern from queue.test.ts): re-checks every 100ms.
async function pollUntil(cond: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`);
}

describe("webhook door — wire bytes preserved", () => {
  it("direct path: raw_body is byte-identical to the posted body (not a re-serialization)", async () => {
    const wire = wireFor("evt-rb-direct");
    const res = await postSigned(createIngestApp(pool, DEFAULT_TENANT_ID), "billing", wire);
    expect(res.status).toBe(202);

    const row = await pool.query(
      "select raw_body, payload from raw.raw_events where event_id = 'evt-rb-direct'",
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].raw_body).toBe(wire);
    // Prove it is the WIRE, not JSON.stringify of the stored payload: the non-canonical
    // spacing cannot survive a parse→stringify round trip.
    expect(row.rows[0].raw_body).not.toBe(JSON.stringify(row.rows[0].payload));
  });

  it("queue path: raw_body rides the job envelope and the worker stores it byte-identically", async () => {
    const dbResult = await pool.query("select current_database() as db");
    const connectionString = process.env.DATABASE_URL!.replace(
      /\/[^/?]*(\?|$)/,
      `/${dbResult.rows[0].db}$1`,
    );
    const boss = await createQueue(connectionString);
    try {
      const app = createIngestApp(pool, DEFAULT_TENANT_ID, {
        enqueue: async (source: Source, event: SourceEvent, rawBody: string): Promise<void> => {
          await enqueueEvent(boss, source, event, { tenantId: DEFAULT_TENANT_ID, rawBody });
        },
      });
      await startWorker(boss, pool, { tenantId: DEFAULT_TENANT_ID });

      const wire = wireFor("evt-rb-queued");
      const res = await postSigned(app, "billing", wire);
      expect(res.status).toBe(202);

      await pollUntil(async () => {
        const r = await pool.query(
          "select count(*)::int as n from raw.raw_events where event_id = 'evt-rb-queued'",
        );
        return r.rows[0].n === 1;
      }, 10_000);

      const row = await pool.query(
        "select raw_body from raw.raw_events where event_id = 'evt-rb-queued'",
      );
      expect(row.rows[0].raw_body).toBe(wire);
    } finally {
      await boss.stop();
    }
  });
});

describe("poll door — no per-event wire bytes exist, so none are invented", () => {
  it("poll-ingested events have raw_body IS NULL and are otherwise unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rawbody-poll-"));
    const feed = createBillingApp({ webhookUrl: "http://127.0.0.1:1", ledgerPath: join(dir, "l.jsonl") });
    const srv: Server = feed.listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      await fetch(`http://127.0.0.1:${port}/simulate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: 5, fault_plan: { seed: 1, dropRate: 1, dupRate: 0, apiErrorRate: 0 } }),
      });
      const result = await pollOnce(pool, "billing", `http://127.0.0.1:${port}`);
      expect(result.ingested).toBe(5);

      const rows = await pool.query(
        "select raw_body, payload, event_id from raw.raw_events where source = 'billing'",
      );
      expect(rows.rowCount).toBe(5);
      for (const r of rows.rows) {
        // The page was parsed as a unit: per-event wire bytes never existed. NULL is the
        // honest value — a re-stringified object claiming to be wire bytes would be a lie.
        expect(r.raw_body).toBeNull();
        expect(r.payload.event_id).toBe(r.event_id); // everything else unchanged
      }
    } finally {
      srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("quarantine replay — every attempt leaves a trace (C4)", () => {
  it("replay of a still-invalid row increments attempts and stamps last_attempt_at, each time", async () => {
    await quarantineEvent(pool, "billing", { event_id: "evt-rb-bad", junk: true }, "schema validation failed: test", undefined, DEFAULT_TENANT_ID);
    const idRow = await pool.query("select id, attempts, last_attempt_at from ingest.quarantine");
    expect(idRow.rowCount).toBe(1);
    const id = Number(idRow.rows[0].id);
    // Fresh rows start untried: attempts 0, no attempt timestamp.
    expect(idRow.rows[0].attempts).toBe(0);
    expect(idRow.rows[0].last_attempt_at).toBeNull();

    const before = Date.now();
    expect(await replayQuarantined(pool, id, ingestEvent)).toBe("still-invalid");
    const after1 = await pool.query(
      "select attempts, last_attempt_at, replayed_at from ingest.quarantine where id = $1",
      [id],
    );
    expect(after1.rows[0].attempts).toBe(1);
    expect(after1.rows[0].last_attempt_at).toBeInstanceOf(Date);
    expect(after1.rows[0].last_attempt_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(after1.rows[0].replayed_at).toBeNull(); // still pending — recording ≠ resolving

    // A second attempt is a second trace: depth interpretation needs the count, not a flag.
    expect(await replayQuarantined(pool, id, ingestEvent)).toBe("still-invalid");
    const after2 = await pool.query("select attempts from ingest.quarantine where id = $1", [id]);
    expect(after2.rows[0].attempts).toBe(2);
  });

  it("a successful replay records the same trace alongside replayed_at", async () => {
    const valid: SourceEvent = {
      event_id: "evt-rb-fixable",
      event_type: "company.updated",
      occurred_at: new Date().toISOString(),
      data: { id: "DEMO-C-0001", name: "DEMO X" },
    };
    await quarantineEvent(pool, "billing", valid, "operator hold: test", undefined, DEFAULT_TENANT_ID);
    const idRow = await pool.query("select id from ingest.quarantine");
    const id = Number(idRow.rows[0].id);

    const result = await replayAllQuarantined(pool, ingestEvent, DEFAULT_TENANT_ID);
    expect(result).toEqual({ replayed: 1, stillInvalid: 0 });

    const after = await pool.query(
      "select attempts, last_attempt_at, replayed_at from ingest.quarantine where id = $1",
      [id],
    );
    expect(after.rows[0].attempts).toBe(1);
    expect(after.rows[0].last_attempt_at).toBeInstanceOf(Date);
    expect(after.rows[0].replayed_at).toBeInstanceOf(Date);

    const raw = await pool.query(
      "select count(*)::int as n from raw.raw_events where event_id = 'evt-rb-fixable'",
    );
    expect(raw.rows[0].n).toBe(1);
  });
});

describe("jsonb-unstorable divert path is untouched by the expand phase", () => {
  it("NUL payload with wire text still quarantines byte-exact and never reaches raw", async () => {
    // \\u0000 in the TS literal = the six-character escape on the wire = an actual NUL after
    // JSON.parse — jsonb-unstorable, diverted BEFORE schema validation and enqueue.
    const wire = `{"event_id":"evt-rb-nul","event_type":"company.updated","occurred_at":"${new Date().toISOString()}","data":{"name":"a\\u0000b"}}`;
    const res = await postSigned(createIngestApp(pool, DEFAULT_TENANT_ID), "billing", wire);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ quarantined: true });

    const q = await pool.query("select raw_body, payload, attempts from ingest.quarantine");
    expect(q.rowCount).toBe(1);
    expect(q.rows[0].raw_body).toBe(wire); // byte-exact custody, exactly as before 007
    expect(q.rows[0].payload).toBeNull();
    expect(q.rows[0].attempts).toBe(0); // new column defaults cleanly on the divert path
    const raw = await pool.query("select count(*)::int as n from raw.raw_events");
    expect(raw.rows[0].n).toBe(0); // never hits the new raw_body column path
  });

  it("depth-diverted payload with wire text still quarantines byte-exact, never raw", async () => {
    const depth = 1200; // past MAX_JSONB_NESTING_DEPTH (1000); JSON.parse survives, divert must fire
    const deep = "[".repeat(depth) + "1" + "]".repeat(depth);
    const wire = `{"event_id":"evt-rb-deep","event_type":"company.updated","occurred_at":"${new Date().toISOString()}","data":{"deep":${deep}}}`;
    const res = await postSigned(createIngestApp(pool, DEFAULT_TENANT_ID), "billing", wire);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ quarantined: true });

    const q = await pool.query("select raw_body from ingest.quarantine");
    expect(q.rowCount).toBe(1);
    expect(q.rows[0].raw_body).toBe(wire);
    const raw = await pool.query("select count(*)::int as n from raw.raw_events");
    expect(raw.rows[0].n).toBe(0);
  });
});

// ── Migration 007 file tests (house pattern from migration-004.test.ts: manual ephemeral
// DB, migration files applied directly, so the file's own idempotency is what's proven —
// runMigrations' tracking would skip the re-run and prove nothing).
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const sql = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");
const ALL = [
  "001_raw_events.sql",
  "002_reliability.sql",
  "003_multi_source.sql",
  "004_nul_safe_quarantine.sql",
  "005_agent_role.sql",
  "006_tenancy.sql",
  "007_raw_body_and_quarantine_ops.sql",
];

describe("migration 007: raw_body + quarantine ops + FOR ROLE grants", () => {
  it("applies via a NON-switchboard migrator, scopes default privileges to the explicit target role (C2), and re-runs cleanly", async () => {
    const originalUrl = process.env.DATABASE_URL!;
    const dbName = `switchboard_test_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const adminUrl = originalUrl.replace(/\/[^/?]*(\?|$)/, "/postgres$1");
    const admin = new pg.Pool({ connectionString: adminUrl });
    await admin.query(`create database "${dbName}"`);
    await admin.end();
    const mpool = new pg.Pool({ connectionString: originalUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) });
    try {
      // Pre-007 state, applied as switchboard (the shipped configuration).
      for (const f of ALL.slice(0, 6)) await mpool.query(sql(f));
      // An existing quarantine row: 007 must default its attempts without rewriting it.
      await mpool.query(
        `insert into ingest.quarantine (source, payload, reason) values ('billing', '{"bogus":true}'::jsonb, 'schema validation failed')`,
      );

      // THE C2 SCENARIO: the role executing the migration is NOT switchboard. An unscoped
      // `alter default privileges` would bind to this migrator role and silently cover
      // nothing dbt creates — the KNOWN-ISSUES trap. Explicit FOR ROLE must survive this.
      await mpool.query(`do $$ begin
        if not exists (select from pg_roles where rolname = 'c2_migrator') then
          create role c2_migrator in role switchboard;
        end if;
      exception when duplicate_object then null; end $$;`);
      await mpool.query("set role c2_migrator");
      await mpool.query(sql("007_raw_body_and_quarantine_ops.sql"));
      await mpool.query("reset role");

      // raw_body: nullable text on raw.raw_events, no read-path change.
      const col = await mpool.query(
        `select data_type, is_nullable from information_schema.columns
          where table_schema = 'raw' and table_name = 'raw_events' and column_name = 'raw_body'`,
      );
      expect(col.rows).toEqual([{ data_type: "text", is_nullable: "YES" }]);

      // C4 columns: attempts NOT NULL DEFAULT 0, last_attempt_at nullable; the pre-existing
      // row adopted the defaults.
      const qrow = await mpool.query("select attempts, last_attempt_at from ingest.quarantine");
      expect(qrow.rows).toEqual([{ attempts: 0, last_attempt_at: null }]);

      // C2 catalog proof: the default-privilege entry targets switchboard EXPLICITLY —
      // defaclrole must be switchboard even though c2_migrator ran the migration — and it
      // carries SELECT for switchboard_agent on future tables.
      const acl = await mpool.query(
        `select r.rolname as target_role, d.defaclacl::text as acl
           from pg_default_acl d
           join pg_roles r on r.oid = d.defaclrole
           join pg_namespace n on n.oid = d.defaclnamespace
          where n.nspname = 'public_analytics' and d.defaclobjtype = 'r'`,
      );
      expect(acl.rowCount).toBe(1);
      expect(acl.rows[0].target_role).toBe("switchboard");
      expect(acl.rows[0].acl).toContain("switchboard_agent=r");

      // Idempotency: the whole sequence again as switchboard (exactly what a tracking-less
      // re-run would do), data intact.
      for (const f of ALL) await mpool.query(sql(f));
      const after = await mpool.query("select count(*)::int as n from ingest.quarantine");
      expect(after.rows[0].n).toBe(1);
      const aclAfter = await mpool.query(
        `select count(*)::int as n from pg_default_acl d
           join pg_namespace n on n.oid = d.defaclnamespace
          where n.nspname = 'public_analytics' and d.defaclobjtype = 'r'`,
      );
      expect(aclAfter.rows[0].n).toBe(1); // re-grant merged, not duplicated
    } finally {
      await mpool.end();
      const admin2 = new pg.Pool({ connectionString: adminUrl });
      await admin2.query(`drop database if exists "${dbName}" with (force)`);
      await admin2.end();
    }
  });
});
