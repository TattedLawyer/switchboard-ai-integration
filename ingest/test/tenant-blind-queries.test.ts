// Gate-H I8 (blocker) and I7 — the two raw SQL statements the SEC-C1 tenancy wave never
// revisited, and a sweep so there is not a third.
//
// The shape, for the third time in one week: a fix applied to one member of a family with
// the siblings missed. SEC-C1 threaded the deployment tenant through both halves of
// ingestion and pinned both — but it threaded the CODE PATHS, and two hand-written
// queries predating it kept reading the whole table. Both sit on DEGRADED paths (a
// reconcile verdict, a catch block), where no default-path test can reach them, and both
// are byte-identical to correct behaviour with SWITCHBOARD_TENANT_ID unset. So:
//
//   1. a static sweep over every SQL literal touching a tenant-scoped table, which is
//      what actually stops the fourth one;
//   2. a behavioural pin on each of the two, driven on a CONFIGURED deployment.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { reconcile } from "../src/reconcile.js";

const INGEST_DIR = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = join(INGEST_DIR, "src");
const TENANT_X = "44444444-4444-4444-4444-444444444444";
const NIL_TENANT = "00000000-0000-0000-0000-000000000000";

// ── 1. the sweep ────────────────────────────────────────────────────────────────────

/** Every table migration 006 / 009 / 010 gave a tenant_id column and an RLS policy. */
const TENANT_SCOPED_TABLES = [
  "raw.raw_events",
  "ingest.ingest_journal",
  "ingest.quarantine",
  "ingest.cursors",
  "ingest.hydrated_snapshots",
  "ingest.gap_ledger",
];

/**
 * Statements that touch a tenant-scoped table WITHOUT naming tenant_id, and are correct
 * anyway. Keyed by a distinctive substring of the statement; the value is the reason,
 * which is the point — an entry with no reason is indistinguishable from the bug.
 */
const ALLOWED_TENANT_BLIND: Record<string, string> = {
  "update ingest.quarantine set attempts":
    "keyed by the row's own primary key, which was read one statement earlier along with " +
    "its recorded tenant; the replay then re-ingests under THAT tenant (SEC-C2).",
  "update ingest.quarantine set replayed_at":
    "same primary key, same statement pair — marking the row just replayed.",
  "select payload, source, tenant_id from ingest.quarantine":
    "the read that MAKES the pair above tenant-correct: it fetches the row's own tenant " +
    "so replay lands in the lane the event arrived on rather than the operator's.",
};

/** Every string literal in a TypeScript file: backtick (multi-line) and double-quoted. */
function stringLiterals(source: string): string[] {
  return [
    ...[...source.matchAll(/`(?:[^`\\]|\\[\s\S])*`/g)].map((m) => m[0]),
    ...[...source.matchAll(/"(?:[^"\\\n]|\\.)*"/g)].map((m) => m[0]),
  ];
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return name.endsWith(".ts") ? [full] : [];
  });
}

describe("no tenant-scoped table is read or written without naming the tenant", () => {
  it("sweeps every SQL literal in ingest/src", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC_DIR)) {
      for (const literal of stringLiterals(readFileSync(file, "utf8"))) {
        // SQL only: the table names also appear in log lines and in the tenant-state
        // CLI's own list of tables to report on, neither of which is a query.
        if (!/\b(select |insert into |update |delete from )/i.test(literal)) continue;
        if (!TENANT_SCOPED_TABLES.some((t) => literal.includes(t))) continue;
        if (literal.includes("tenant_id")) continue;
        const allowed = Object.keys(ALLOWED_TENANT_BLIND).find((k) => literal.includes(k));
        if (allowed !== undefined) continue;
        offenders.push(`${file.slice(INGEST_DIR.length)}: ${literal.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
    expect(
      offenders,
      "tenant-blind SQL. Either add the predicate, or add an entry to ALLOWED_TENANT_BLIND " +
        `with the reason it is correct:\n  - ${offenders.join("\n  - ")}`,
    ).toEqual([]);
  });
});

// ── 2. the two behavioural pins ─────────────────────────────────────────────────────

let pool: pg.Pool;
let dbUrl: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  dbUrl = result.url;
  cleanup = result.cleanup;
});
afterEach(async () => {
  await cleanup();
});

async function insertRaw(tenantId: string, source: string, eventId: string): Promise<void> {
  await pool.query(
    `insert into raw.raw_events (tenant_id, source, event_id, event_type, payload)
     values ($1, $2, $3, 'x.created', $4)`,
    [tenantId, source, eventId, JSON.stringify({ event_id: eventId })],
  );
}

describe("I8 — the ledger-feed reconcile on a database that migrated INTO tenancy", () => {
  it("does not report a cross-tenant event_id as an unexplained raw duplicate", async () => {
    // The documented migration path: rows ingested before SWITCHBOARD_TENANT_ID was set
    // sit under the nil tenant; rows after it sit under the configured one. Migration 006
    // made uniqueness (tenant_id, source, event_id), so the SAME id legitimately exists
    // twice — which the reconcile's comment still believed impossible, citing an index
    // (uq_raw_events_source_event_id, migration 003) that 006 replaced.
    await insertRaw(NIL_TENANT, "billing", "evt-shared");
    await insertRaw(TENANT_X, "billing", "evt-shared");
    await insertRaw(TENANT_X, "billing", "evt-only-x");

    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const ledger = join(mkdtempSync(join(tmpdir(), "i8-")), "ledger.jsonl");
    writeFileSync(
      ledger,
      [{ event_id: "evt-shared" }, { event_id: "evt-only-x" }].map((e) => JSON.stringify(e)).join("\n"),
    );

    const report = await reconcile(pool, "billing", ledger);
    // The whole-lane comparison is the DISCLOSED design (the ledger is the whole feed, it
    // carries no tenant, and scoping it would report every pre-tenancy row as missing).
    // What must not happen is the unexplained red.
    expect(report.missing).toEqual([]);
    expect(report.extra).toEqual([]);
    expect(
      report.rawDuplicates,
      "rawDuplicates must count DUPLICATE ROWS, which (tenant_id, source, event_id) still forbids",
    ).toBe(0);
    expect(
      report.crossTenantEventIds,
      "the legitimate cross-tenant collision must be reported as itself, so the operator is not left with a bare FAIL",
    ).toEqual(["evt-shared"]);
  });

  it("reports nothing cross-tenant on a single-tenant deployment", () => {
    // Negative control: the field must not become a permanent noise line.
    return (async () => {
      await insertRaw(NIL_TENANT, "billing", "evt-a");
      const { writeFileSync, mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const ledger = join(mkdtempSync(join(tmpdir(), "i8b-")), "ledger.jsonl");
      writeFileSync(ledger, JSON.stringify({ event_id: "evt-a" }));
      const report = await reconcile(pool, "billing", ledger);
      expect(report.crossTenantEventIds ?? []).toEqual([]);
      expect(report.rawDuplicates).toBe(0);
    })();
  });
});

describe("I7 — the backfill CLI's failure path quotes THIS tenant's cursor", () => {
  it("prints the configured tenant's resume position, not an arbitrary lane's", async () => {
    // Both lanes hold a cursor for the same source — the documented pre-tenancy/configured
    // coexistence. Without a tenant predicate, rows[0] is whichever the plan emits first.
    await pool.query(
      `insert into ingest.cursors (tenant_id, source, last_seq, last_event_id)
       values ($1, 'support', 11, 'evt-nil-cursor'), ($2, 'support', 22, 'evt-x-cursor')`,
      [NIL_TENANT, TENANT_X],
    );
    // Point the source at a closed port so catchUp throws and the failure block runs — it
    // is the only path that reads the cursor, which is why nothing covered it.
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        ["--import", "tsx", "src/cli/backfill.ts"],
        {
          cwd: INGEST_DIR,
          timeout: 60_000,
          env: {
            ...process.env,
            DATABASE_URL: dbUrl,
            ALLOW_DEV_SECRETS: "1",
            SWITCHBOARD_TENANT_ID: TENANT_X,
            INGEST_SOURCES: "support",
            SUPPORT_BASE_URL: "http://127.0.0.1:1",
          },
        },
        (err, stdout, stderr) => {
          if (err && typeof err.code !== "number") return reject(err);
          resolve(`${stdout}\n${stderr}`);
        },
      );
    });
    expect(out).toContain("evt-x-cursor");
    expect(out, "the nil tenant's cursor is a wrong resume position printed mid-incident").not.toContain(
      "evt-nil-cursor",
    );
  });
});
