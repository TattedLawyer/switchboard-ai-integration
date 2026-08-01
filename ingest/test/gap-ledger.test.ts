import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type pg from "pg";
import { createStripeFeedApp, type StripeFeedApp } from "../../mocks/stripefeed/src/index.js";
import { freshTestDb, type TestDbResult } from "./helpers/testdb.js";
import { runMigrations } from "../src/migrate.js";
import { StripeFeedConnector, type StripeFeedReconcileReport } from "../src/connectors/stripe-feed.js";
import { acknowledgeGap, listGaps, recordGap } from "../src/connectors/types.js";

// Task D pair 2 — the DURABLE gap ledger, and the retrofit that makes it real for two
// paradigms at once.
//
// The lie this replaces: gap detection was PER-PROCESS. Task B's stripefeed connector
// detected a retention gap, printed it, and forgot it when the process exited — so
// whether reconcile failed depended on whether the same process had happened to run the
// fallback. That made "reconcile is the gate" timing-dependent, and it forced alerting to
// key on a LOG LINE rather than on state. The register said: build the durable record
// ONCE, shaped for both paradigms, and have both connectors write it.
//
// Semantics landed here (deliberate, and pinned below):
//   · A gap is IDENTIFIED by (tenant, source, cause, from_event_id). The same permanent
//     loss re-detected by a later run is the SAME gap — re-recording is idempotent, so a
//     cron loop cannot manufacture a thousand rows for one loss.
//   · reconcile FAILS on any UNACKNOWLEDGED gap and PASSES once an operator acknowledges
//     it. A permanent loss is loud exactly once and then becomes a standing disclosed
//     condition — never a permanent red, which is the state that trains people to stop
//     reading reconcile.
//   · Everything is tenant-scoped, in the QUERY and not by filtering afterwards
//     (migration 006's floor; the Task C cold review found a tenant-blind terminal store
//     precisely because every test used the default tenant — so the tests below use a
//     NON-DEFAULT tenant on purpose).

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

let db: TestDbResult;
let pool: pg.Pool;
let srv: Server | undefined;

beforeEach(async () => {
  db = await freshTestDb();
  pool = db.pool;
});
afterEach(async () => {
  srv?.close();
  srv = undefined;
  await db.cleanup();
});

function listen(app: StripeFeedApp): string {
  const server = app.app.listen(0);
  srv = server;
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("migration 010 — the gap table and the stream-identity column", () => {
  it("creates ingest.gap_ledger with tenancy, RLS, and the acknowledgement fields, and re-running is a no-op", async () => {
    const cols = await pool.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
        where table_schema = 'ingest' and table_name = 'gap_ledger' order by column_name`,
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toEqual([
      "acknowledged_at",
      "acknowledged_by",
      "cause",
      "detected_at",
      "from_event_id",
      "from_occurred_at",
      "id",
      "note",
      "source",
      "tenant_id",
      "to_event_id",
      "to_occurred_at",
    ]);

    const rls = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'ingest.gap_ledger'::regclass",
    );
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    // The bus paradigm distinguishes an age-out from a reset by STREAM IDENTITY, so the
    // cursor row has to remember which stream its replay id came from.
    const cursorCols = await pool.query(
      `select column_name from information_schema.columns
        where table_schema = 'ingest' and table_name = 'cursors' and column_name = 'stream_id'`,
    );
    expect(cursorCols.rowCount).toBe(1);

    // Idempotent, house style.
    await runMigrations(pool);
    await runMigrations(pool);
    const after = await pool.query("select count(*)::int as n from ingest.gap_ledger");
    expect(after.rows[0].n).toBe(0);
  });

  it("refuses a cause outside the declared vocabulary — the two honest boundaries, not a free-text field", async () => {
    await expect(
      pool.query(
        `insert into ingest.gap_ledger (tenant_id, source, cause, from_event_id) values ($1, 'casebus', 'vibes', 'x')`,
        [TENANT_A],
      ),
    ).rejects.toThrow();
  });
});

describe("recordGap — one permanent loss is ONE row, however many times it is re-detected", () => {
  it("records a gap, returns it with ISO timestamps, and re-recording the same loss does not duplicate it", async () => {
    const first = await recordGap(pool, {
      tenantId: TENANT_A,
      source: "casebus",
      cause: "retention",
      fromEventId: "cev_abc",
      fromOccurredAt: "2026-07-01T00:00:00.000Z",
      toEventId: "cev_def",
      toOccurredAt: "2026-07-04T00:00:00.000Z",
    });
    expect(first.id).toBeGreaterThan(0);
    expect(first.cause).toBe("retention");
    expect(first.acknowledgedAt).toBeNull();
    // node-pg hands back Date OBJECTS for timestamptz (the trap that made an === compare
    // dead code in Task C). Everything crossing this boundary is an ISO STRING, so every
    // downstream comparison is by VALUE.
    expect(typeof first.detectedAt).toBe("string");
    expect(first.fromOccurredAt).toBe("2026-07-01T00:00:00.000Z");
    expect(first.toOccurredAt).toBe("2026-07-04T00:00:00.000Z");

    const again = await recordGap(pool, {
      tenantId: TENANT_A,
      source: "casebus",
      cause: "retention",
      fromEventId: "cev_abc",
      fromOccurredAt: "2026-07-01T00:00:00.000Z",
      toEventId: "cev_zzz",
      toOccurredAt: "2026-07-09T00:00:00.000Z",
    });
    expect(again.id).toBe(first.id);
    expect(await listGaps(pool, TENANT_A, "casebus")).toHaveLength(1);
  });

  it("the SAME cursor lost to two different causes is two different gaps — cause is part of the identity", async () => {
    const common = { tenantId: TENANT_A, source: "casebus", fromEventId: "cev_abc", fromOccurredAt: null, toEventId: null, toOccurredAt: null };
    const a = await recordGap(pool, { ...common, cause: "retention" });
    const b = await recordGap(pool, { ...common, cause: "reset" });
    expect(b.id).not.toBe(a.id);
    expect((await listGaps(pool, TENANT_A, "casebus")).map((g) => g.cause).sort()).toEqual(["reset", "retention"]);
  });

  it("an unknown near edge (no prior cursor) is an honest NULL and still dedupes to one row", async () => {
    const g = await recordGap(pool, {
      tenantId: TENANT_A, source: "casebus", cause: "reset",
      fromEventId: null, fromOccurredAt: null, toEventId: null, toOccurredAt: null,
    });
    expect(g.fromEventId).toBeNull();
    await recordGap(pool, {
      tenantId: TENANT_A, source: "casebus", cause: "reset",
      fromEventId: null, fromOccurredAt: null, toEventId: null, toOccurredAt: null,
    });
    expect(await listGaps(pool, TENANT_A, "casebus")).toHaveLength(1);
  });
});

describe("tenancy — pinned with a NON-DEFAULT tenant on both sides (the Task C cold-review lesson)", () => {
  it("two tenants losing the SAME vendor cursor get their own gaps, and neither can see or acknowledge the other's", async () => {
    const shape = { source: "casebus", cause: "retention" as const, fromEventId: "cev_shared", fromOccurredAt: null, toEventId: null, toOccurredAt: null };
    const a = await recordGap(pool, { ...shape, tenantId: TENANT_A });
    const b = await recordGap(pool, { ...shape, tenantId: TENANT_B });
    expect(b.id).not.toBe(a.id);

    expect((await listGaps(pool, TENANT_A, "casebus")).map((g) => g.id)).toEqual([a.id]);
    expect((await listGaps(pool, TENANT_B, "casebus")).map((g) => g.id)).toEqual([b.id]);

    // Acknowledging across the tenant line must do NOTHING — not silently succeed.
    expect(await acknowledgeGap(pool, { tenantId: TENANT_B, id: a.id, by: "mallory", note: "not mine" })).toBeNull();
    expect((await listGaps(pool, TENANT_A, "casebus"))[0].acknowledgedAt).toBeNull();
  });

  it("gaps are scoped by SOURCE too — one paradigm's loss never shows up under another's name", async () => {
    await recordGap(pool, { tenantId: TENANT_A, source: "casebus", cause: "retention", fromEventId: "cev_1", fromOccurredAt: null, toEventId: null, toOccurredAt: null });
    await recordGap(pool, { tenantId: TENANT_A, source: "stripefeed", cause: "retention", fromEventId: "evt_1", fromOccurredAt: null, toEventId: null, toOccurredAt: null });
    expect(await listGaps(pool, TENANT_A, "casebus")).toHaveLength(1);
    expect(await listGaps(pool, TENANT_A, "stripefeed")).toHaveLength(1);
  });
});

describe("acknowledgement — the workflow Task B deliberately left open", () => {
  it("an acknowledged gap keeps its bounds, gains an operator and a note, and stops being unacknowledged", async () => {
    const g = await recordGap(pool, {
      tenantId: TENANT_A, source: "casebus", cause: "reset",
      fromEventId: "cev_abc", fromOccurredAt: "2026-07-01T00:00:00.000Z", toEventId: null, toOccurredAt: null,
    });
    const acked = await acknowledgeGap(pool, { tenantId: TENANT_A, id: g.id, by: "oncall", note: "org instance move 2026-07-30; loss accepted" });
    expect(acked).not.toBeNull();
    expect(acked!.acknowledgedBy).toBe("oncall");
    expect(typeof acked!.acknowledgedAt).toBe("string");
    expect(acked!.note).toContain("loss accepted");
    expect(acked!.fromOccurredAt).toBe("2026-07-01T00:00:00.000Z"); // bounds survive

    expect(await listGaps(pool, TENANT_A, "casebus", { unacknowledgedOnly: true })).toHaveLength(0);
    expect(await listGaps(pool, TENANT_A, "casebus")).toHaveLength(1); // still on the record, forever
  });

  it("acknowledging an id that does not exist returns null rather than pretending", async () => {
    expect(await acknowledgeGap(pool, { tenantId: TENANT_A, id: 99999, by: "oncall" })).toBeNull();
  });

  it("re-detecting an ACKNOWLEDGED gap does not silently un-acknowledge it (the loss did not get worse; it is the same loss)", async () => {
    const g = await recordGap(pool, { tenantId: TENANT_A, source: "casebus", cause: "retention", fromEventId: "cev_abc", fromOccurredAt: null, toEventId: null, toOccurredAt: null });
    await acknowledgeGap(pool, { tenantId: TENANT_A, id: g.id, by: "oncall" });
    await recordGap(pool, { tenantId: TENANT_A, source: "casebus", cause: "retention", fromEventId: "cev_abc", fromOccurredAt: null, toEventId: null, toOccurredAt: null });
    expect(await listGaps(pool, TENANT_A, "casebus", { unacknowledgedOnly: true })).toHaveLength(0);
  });
});

describe("the stripefeed retrofit — the register said BUILD ONCE, BOTH CONNECTORS WRITE", () => {
  it("a retention fallback persists its gap, and a FRESH connector instance still reports it (per-process amnesia is over)", async () => {
    const mock = createStripeFeedApp({ seed: 42 });
    const baseUrl = listen(mock);

    mock.feed.emit(8, { ageS: 26 * 86_400 });
    expect(await new StripeFeedConnector({ baseUrl, pageLimit: 10 }).catchUp(pool)).toBe(8);
    mock.feed.emit(6);
    mock.feed.advance(5 * 86_400); // the first batch, and the cursor with it, ages out

    const report = await new StripeFeedConnector({ baseUrl, pageLimit: 10 }).catchUpWithReport(pool);
    expect(report.gaps).toHaveLength(1);

    // The durable record: same bounds, same cause, in the table — with no in-memory
    // witness involved.
    const stored = await listGaps(pool, "00000000-0000-0000-0000-000000000000", "stripefeed");
    expect(stored).toHaveLength(1);
    expect(stored[0].cause).toBe("retention");
    expect(stored[0].fromEventId).toBe(report.gaps[0].fromEventId);
    expect(stored[0].fromOccurredAt).toBe(report.gaps[0].fromOccurredAt);
    expect(stored[0].toOccurredAt).toBe(report.gaps[0].toOccurredAt);

    // The whole point: a connector that never saw the fallback still reports the loss.
    const amnesiac = new StripeFeedConnector({ baseUrl, pageLimit: 10 });
    const rec = (await amnesiac.reconcile(pool)).report as StripeFeedReconcileReport;
    expect(rec.gaps).toHaveLength(1);
    expect(rec.gaps[0].fromEventId).toBe(report.gaps[0].fromEventId);
  });

  it("re-draining after the fallback does not manufacture a second gap row for the same loss", async () => {
    const mock = createStripeFeedApp({ seed: 7 });
    const baseUrl = listen(mock);
    mock.feed.emit(5, { ageS: 26 * 86_400 });
    await new StripeFeedConnector({ baseUrl, pageLimit: 10 }).catchUp(pool);
    mock.feed.emit(4);
    mock.feed.advance(5 * 86_400);

    await new StripeFeedConnector({ baseUrl, pageLimit: 10 }).catchUpWithReport(pool);
    await new StripeFeedConnector({ baseUrl, pageLimit: 10 }).catchUpWithReport(pool);
    await new StripeFeedConnector({ baseUrl, pageLimit: 10 }).catchUpWithReport(pool);
    expect(await listGaps(pool, "00000000-0000-0000-0000-000000000000", "stripefeed")).toHaveLength(1);
  });
});

describe("re-detection ENRICHES but never rewrites (cold review I2, disclosed decision)", () => {
  it("a later detection carrying MORE information fills a null field — the ledger only ever gets more truthful", async () => {
    const first = await recordGap(pool, {
      tenantId: TENANT_A, source: "casebus", cause: "retention",
      fromEventId: "cev_abc", fromOccurredAt: null, toEventId: null, toOccurredAt: null,
    });
    expect(first.toEventId).toBeNull();

    // The same loss, seen by a surface that could name more of it.
    const enriched = await recordGap(pool, {
      tenantId: TENANT_A, source: "casebus", cause: "retention",
      fromEventId: "cev_abc", fromOccurredAt: "2026-07-01T00:00:00.000Z",
      toEventId: "cev_def", toOccurredAt: "2026-07-04T00:00:00.000Z",
    });
    expect(enriched.id).toBe(first.id); // still ONE loss, one row
    expect(enriched.toEventId).toBe("cev_def");
    expect(enriched.toOccurredAt).toBe("2026-07-04T00:00:00.000Z");
    expect(enriched.fromOccurredAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("a POPULATED field is never overwritten, and never downgraded to null — bounds are a factual claim, not a running estimate", async () => {
    const first = await recordGap(pool, {
      tenantId: TENANT_A, source: "casebus", cause: "retention",
      fromEventId: "cev_abc", fromOccurredAt: "2026-07-01T00:00:00.000Z",
      toEventId: "cev_def", toOccurredAt: "2026-07-04T00:00:00.000Z",
    });

    // A later, WIDER far edge must not widen a loss that never grew (the window has moved
    // on since; that is the window's metabolism, not more loss).
    const wider = await recordGap(pool, {
      tenantId: TENANT_A, source: "casebus", cause: "retention",
      fromEventId: "cev_abc", fromOccurredAt: "2026-06-01T00:00:00.000Z",
      toEventId: "cev_zzz", toOccurredAt: "2026-07-09T00:00:00.000Z",
    });
    expect(wider.id).toBe(first.id);
    expect(wider.toEventId).toBe("cev_def");
    expect(wider.toOccurredAt).toBe("2026-07-04T00:00:00.000Z");
    expect(wider.fromOccurredAt).toBe("2026-07-01T00:00:00.000Z");

    // And a POORER later detection cannot blank what we already knew.
    const poorer = await recordGap(pool, {
      tenantId: TENANT_A, source: "casebus", cause: "retention",
      fromEventId: "cev_abc", fromOccurredAt: null, toEventId: null, toOccurredAt: null,
    });
    expect(poorer.toEventId).toBe("cev_def");
    expect(poorer.fromOccurredAt).toBe("2026-07-01T00:00:00.000Z");
    expect(await listGaps(pool, TENANT_A, "casebus")).toHaveLength(1);
  });

  it("enrichment never disturbs the acknowledgement — the operator's answer survives every later re-detection", async () => {
    const g = await recordGap(pool, {
      tenantId: TENANT_A, source: "casebus", cause: "retention",
      fromEventId: "cev_abc", fromOccurredAt: null, toEventId: null, toOccurredAt: null,
    });
    await acknowledgeGap(pool, { tenantId: TENANT_A, id: g.id, by: "oncall", note: "accepted" });

    const enriched = await recordGap(pool, {
      tenantId: TENANT_A, source: "casebus", cause: "retention",
      fromEventId: "cev_abc", fromOccurredAt: "2026-07-01T00:00:00.000Z", toEventId: "cev_def", toOccurredAt: null,
    });
    expect(enriched.toEventId).toBe("cev_def");   // enriched…
    expect(enriched.acknowledgedBy).toBe("oncall"); // …without resurrecting the red
    expect(enriched.note).toBe("accepted");
    expect(await listGaps(pool, TENANT_A, "casebus", { unacknowledgedOnly: true })).toHaveLength(0);
  });
});
