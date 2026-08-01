import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type pg from "pg";
// The REAL mock + manifest, in-process — same cross-workspace precedent as sheet-oracle.test.ts.
import { COL, createSheetsApp, type SheetsApp, type SheetsAppOptions } from "../../mocks/sheets/src/index.js";
import { generateManifest } from "../../mocks/core/src/manifest.js";
import { freshTestDb } from "./helpers/testdb.js";
import { loadModel } from "./helpers/load-model.js";
import { SheetSnapshotConnector } from "../src/connectors/sheet-snapshot.js";
import {
  canonicalRowContent,
  contentHash,
  resolveHeaderMapping,
} from "../src/connectors/sheet-canonical.js";

// Task A6 — warehouse consumption of the sheets source (stage 2 of the two-stage oracle).
// Three RED→GREEN pairs, named:
//   pair 1 "staging + identity": stg_sheets__rows exists with the SUCCESSOR ordering
//                                (occurred_at desc, received_at desc, event_id desc — the
//                                ms-tie landmine pinned, not assumed), tombstones filter,
//                                L2/L5 guards; sheets enter identity_resolution as a
//                                fourth source — ONE candidate tuple per client email
//                                (the L2-G3 straddle collapsed BEFORE the tiers),
//                                no-email rows to tier-3 manual review, tiers untouched.
//   pair 2 "mart + surfaces":    customer_360 sheet columns under the per-source currency
//                                machinery (sheet sums NEVER fold into deal/invoice sums),
//                                every new OR term isolatively pinned; singular tests,
//                                MCP allowlist + mirrors, registry floor, ci-fixture.
//   pair 3 "stage-2 oracle":     loadModel-chains the REAL staging+identity+mart SQL over
//                                fault-plan-driven connector output — sheet ⇄ mart.
//
// All A6 pins live in THIS file (permitted-files discipline): the staging/identity/mart
// unit pins use the merge-resolution/mart-currency fixture technique; the oracle uses the
// A5 in-process pattern extended one layer down.

let pool: pg.Pool;
let cleanup: () => Promise<void>;
let srv: Server | undefined; // mock sheet server (pair 3)

beforeEach(async () => {
  ({ pool, cleanup } = await freshTestDb());
});
afterEach(async () => {
  srv?.close();
  srv = undefined;
  await cleanup();
});

// The REAL staging model, loaded from disk. It reads raw.raw_events directly (no refs),
// which freshTestDb provides — the same lane the connector ingests into.
const STAGING_SQL = loadModel("models/staging/stg_sheets__rows.sql");

const stagingRows = async (db: pg.Pool): Promise<Record<string, unknown>[]> =>
  (await db.query(`select * from (${STAGING_SQL}) s order by row_key`)).rows;

/** Direct raw inserts for the staging pins: the shapes the CONNECTOR mints (content-
 *  addressed ids, occurred_at_derived detection clock), with received_at controlled
 *  explicitly — the ms-tie landmine cannot be reproduced deterministically through the
 *  live door (received_at is the door's own now()), so the pin writes the exact raw
 *  states rapid catchUp cycles produce. */
const insertSheetRaw = async (
  db: pg.Pool,
  eventId: string,
  eventType: "sheet.row_upserted" | "sheet.row_deleted",
  occurredAt: string,
  data: Record<string, unknown>,
  receivedAt?: string,
): Promise<void> => {
  await db.query(
    `insert into raw.raw_events (source, event_id, event_type, payload, received_at)
     values ('sheets', $1, $2, $3::jsonb, coalesce($4::timestamptz, now()))`,
    [eventId, eventType, JSON.stringify({ occurred_at: occurredAt, data }), receivedAt ?? null],
  );
};

const upsertData = (rowKey: string, hash: string, fields: Record<string, unknown> = {}) => ({
  row_key: rowKey,
  content_hash: hash,
  occurred_at_derived: true,
  ...fields,
});

// ── A6 pair 1 — staging: successor ordering, tombstone filter, guards ────────────────────

describe("A6 pair 1 — stg_sheets__rows: latest-state under the successor ordering", () => {
  it("maps the connector's canonical fields to the staging vocabulary: email→client_email, company→company_name, deal→label; amount/currency/status/content_hash carried", async () => {
    await insertSheetRaw(pool, "sheet-rk-0001-aaaaaaaaaaaaaaaa", "sheet.row_upserted", "2026-07-28T10:00:00.000Z", upsertData("rk-0001", "aaaaaaaaaaaaaaaa", {
      client_name: "Jane Doe",
      email: "jane@acme.example.com",
      company: "Acme Group",
      deal: "Acme Expansion",
      amount_cents: 123456,
      currency: "USD",
      status: "open",
    }));

    const rows = await stagingRows(pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      row_key: "rk-0001",
      client_email: "jane@acme.example.com",
      client_name: "Jane Doe",
      company_name: "Acme Group",
      amount_cents: "123456",
      currency: "USD",
      status: "open",
      label: "Acme Expansion",
      content_hash: "aaaaaaaaaaaaaaaa",
    });
  });

  it("latest state per row_key: a later occurred_at supersedes, regardless of insertion order", async () => {
    // Stale detection delivered AFTER the fresh one — occurred_at, not raw id, decides.
    await insertSheetRaw(pool, "sheet-rk-0001-bbbbbbbbbbbbbbbb", "sheet.row_upserted", "2026-07-28T10:00:02.000Z", upsertData("rk-0001", "bbbbbbbbbbbbbbbb", { status: "won" }));
    await insertSheetRaw(pool, "sheet-rk-0001-aaaaaaaaaaaaaaaa", "sheet.row_upserted", "2026-07-28T10:00:01.000Z", upsertData("rk-0001", "aaaaaaaaaaaaaaaa", { status: "open" }));

    const rows = await stagingRows(pool);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("won");
    expect(rows[0].content_hash).toBe("bbbbbbbbbbbbbbbb");
  });

  it("MS-TIE PIN (carried landmine 1): identical occurred_at at ms grain across rapid catchUp cycles — received_at breaks the tie toward the LATER INGEST, even when lexicographic event_id order contradicts it", async () => {
    // Two cycles detect different content for the same row inside the same millisecond.
    // The ids are content hashes — arbitrary-looking order. Constructed so the WRONG
    // tiebreak is loud: the EARLIER ingest carries the lexicographically LARGER id
    // (ffff… > 0000…), so a model that skips received_at and falls straight to
    // event_id desc resolves to the STALE cycle. received_at desc must win first.
    const t = "2026-07-28T10:00:00.123Z";
    await insertSheetRaw(pool, "sheet-rk-0001-ffffffffffffffff", "sheet.row_upserted", t, upsertData("rk-0001", "ffffffffffffffff", { status: "open" }), "2026-07-28T10:00:00.200000Z");
    await insertSheetRaw(pool, "sheet-rk-0001-0000000000000000", "sheet.row_upserted", t, upsertData("rk-0001", "0000000000000000", { status: "renegotiating" }), "2026-07-28T10:00:00.300000Z");

    const rows = await stagingRows(pool);
    expect(rows).toHaveLength(1);
    // The later ingest (received_at 00.3) wins — deterministically, pinned here rather
    // than discovered in a flaky demo.
    expect(rows[0].status).toBe("renegotiating");
    expect(rows[0].content_hash).toBe("0000000000000000");
  });

  it("full-tie determinism: identical occurred_at AND received_at — event_id desc is the last-resort deterministic tiebreak (content-hash ids: arbitrary-looking, stable)", async () => {
    const t = "2026-07-28T10:00:00.123Z";
    const r = "2026-07-28T10:00:00.200000Z";
    await insertSheetRaw(pool, "sheet-rk-0001-1111111111111111", "sheet.row_upserted", t, upsertData("rk-0001", "1111111111111111", { status: "open" }), r);
    await insertSheetRaw(pool, "sheet-rk-0001-9999999999999999", "sheet.row_upserted", t, upsertData("rk-0001", "9999999999999999", { status: "won" }), r);

    const rows = await stagingRows(pool);
    expect(rows).toHaveLength(1);
    expect(rows[0].content_hash).toBe("9999999999999999"); // larger id wins, every run
  });

  it("supersession-suffix tolerance: an ABA revert's `-r1` re-sighting (A4.1 salt) is an ordinary, orderable event id — the revert is the live state, and nothing tries to parse an ordinal out of these ids", async () => {
    // A→B→A across three cycles: the revert's id is the base id + '-r1'. The ordering
    // must TOLERATE the salt — sheet ids order as opaque text (a copied evt-N ordinal
    // tiebreak would crash casting 't-rk-0001…' to bigint). A full-clock tie between a
    // -r1 and its OWN base is content-indistinguishable by construction (the salt exists
    // because the content is identical), so the observable pin is the revert landing and
    // winning through the successor ordering like any other event.
    await insertSheetRaw(pool, "sheet-rk-0001-aaaaaaaaaaaaaaaa", "sheet.row_upserted", "2026-07-28T10:00:00.100Z", upsertData("rk-0001", "aaaaaaaaaaaaaaaa", { status: "open" }), "2026-07-28T10:00:00.150000Z");
    await insertSheetRaw(pool, "sheet-rk-0001-bbbbbbbbbbbbbbbb", "sheet.row_upserted", "2026-07-28T10:00:00.500Z", upsertData("rk-0001", "bbbbbbbbbbbbbbbb", { status: "won" }), "2026-07-28T10:00:00.600000Z");
    await insertSheetRaw(pool, "sheet-rk-0001-aaaaaaaaaaaaaaaa-r1", "sheet.row_upserted", "2026-07-28T10:00:00.900Z", upsertData("rk-0001", "aaaaaaaaaaaaaaaa", { status: "open" }), "2026-07-28T10:00:01.000000Z");

    const rows = await stagingRows(pool);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("open"); // the revert (…-r1) is the live state
    expect(rows[0].content_hash).toBe("aaaaaaaaaaaaaaaa");
  });

  it("tombstone as FILTER: a row whose LATEST event is sheet.row_deleted vanishes from the model's output — no is_deleted flag, no residual row", async () => {
    await insertSheetRaw(pool, "sheet-rk-0001-aaaaaaaaaaaaaaaa", "sheet.row_upserted", "2026-07-28T10:00:01.000Z", upsertData("rk-0001", "aaaaaaaaaaaaaaaa", { status: "open" }));
    await insertSheetRaw(pool, "sheet-rk-0002-cccccccccccccccc", "sheet.row_upserted", "2026-07-28T10:00:01.000Z", upsertData("rk-0002", "cccccccccccccccc", { status: "open" }));
    await insertSheetRaw(pool, "sheet-rk-0001-del-aaaaaaaaaaaaaaaa", "sheet.row_deleted", "2026-07-28T10:00:02.000Z", { row_key: "rk-0001", last_content_hash: "aaaaaaaaaaaaaaaa", occurred_at_derived: true });

    const rows = await stagingRows(pool);
    expect(rows.map((r) => r.row_key)).toEqual(["rk-0002"]); // rk-0001 is GONE, not flagged
  });

  it("a delete superseded by a later re-upsert brings the row BACK — the filter reads latest state, not delete-existence", async () => {
    await insertSheetRaw(pool, "sheet-rk-0001-aaaaaaaaaaaaaaaa", "sheet.row_upserted", "2026-07-28T10:00:01.000Z", upsertData("rk-0001", "aaaaaaaaaaaaaaaa", { status: "open" }));
    await insertSheetRaw(pool, "sheet-rk-0001-del-aaaaaaaaaaaaaaaa", "sheet.row_deleted", "2026-07-28T10:00:02.000Z", { row_key: "rk-0001", last_content_hash: "aaaaaaaaaaaaaaaa", occurred_at_derived: true });
    await insertSheetRaw(pool, "sheet-rk-0001-dddddddddddddddd", "sheet.row_upserted", "2026-07-28T10:00:03.000Z", upsertData("rk-0001", "dddddddddddddddd", { status: "won" }));

    const rows = await stagingRows(pool);
    expect(rows).toHaveLength(1);
    expect(rows[0].content_hash).toBe("dddddddddddddddd");
  });

  it("L2 safe cast + currency guard: doorless garbage degrades to NULL (never kills the build), absent fields are NULL — nullable BY DESIGN, not decay", async () => {
    // Doorless rows exist by design (direct inserts, historical backfill): the ingest
    // contract would have quarantined these; staging's job is blast-radius containment.
    await insertSheetRaw(pool, "sheet-rk-0001-aaaaaaaaaaaaaaaa", "sheet.row_upserted", "2026-07-28T10:00:01.000Z", upsertData("rk-0001", "aaaaaaaaaaaaaaaa", { amount_cents: "US$ 500", currency: "usd" }));
    // Absent amount/currency (blank cells at the source — the honest doorful case):
    await insertSheetRaw(pool, "sheet-rk-0002-cccccccccccccccc", "sheet.row_upserted", "2026-07-28T10:00:01.000Z", upsertData("rk-0002", "cccccccccccccccc", { email: "jane@acme.example.com" }));

    const rows = await stagingRows(pool);
    expect(rows).toHaveLength(2);
    expect(rows[0].amount_cents).toBeNull(); // 'US$ 500' fails pg_input_is_valid(bigint)
    expect(rows[0].currency).toBeNull(); // 'usd' fails ^[A-Z]{3}$
    expect(rows[1].amount_cents).toBeNull(); // absent → NULL
    expect(rows[1].currency).toBeNull();
  });

  it("client_key manufacture: email rows key on 'email:'||lower(trim(email)); rows with no usable email key on 'row:'||row_key — the sheets client spine, minted ONCE at staging", async () => {
    await insertSheetRaw(pool, "sheet-rk-0001-aaaaaaaaaaaaaaaa", "sheet.row_upserted", "2026-07-28T10:00:01.000Z", upsertData("rk-0001", "aaaaaaaaaaaaaaaa", { email: "  Jane@Acme.example.COM " }));
    await insertSheetRaw(pool, "sheet-rk-0002-cccccccccccccccc", "sheet.row_upserted", "2026-07-28T10:00:01.000Z", upsertData("rk-0002", "cccccccccccccccc", { company: "Acme Group" }));
    // Whitespace-only email is NOT a usable client id — never 'email:':
    await insertSheetRaw(pool, "sheet-rk-0003-eeeeeeeeeeeeeeee", "sheet.row_upserted", "2026-07-28T10:00:01.000Z", upsertData("rk-0003", "eeeeeeeeeeeeeeee", { email: "   " }));

    const rows = await stagingRows(pool);
    expect(rows.map((r) => r.client_key)).toEqual([
      "email:jane@acme.example.com",
      "row:rk-0002",
      "row:rk-0003",
    ]);
  });
});

// ── A6 pair 1 — identity: sheets as a fourth source through the REAL tier machinery ──────

// The merge-resolution fixture technique: the REAL identity_resolution.sql from disk,
// refs → fixture tables/views. Nothing here mirrors the model text.
const IDENTITY_SQL = `
  select source, source_entity_id, resolved_entity_id, matched_tier, match_evidence
  from (${loadModel("models/identity/identity_resolution.sql", {
    int_crm__canonical_companies: "tmp_canonical",
    stg_crm__companies: "tmp_stg_companies",
    stg_crm__contacts: "tmp_stg_contacts",
    stg_billing__customers: "tmp_stg_billing",
    stg_support__tickets: "tmp_stg_support",
    stg_sheets__rows: "tmp_sheet_rows",
    free_email_domains: "tmp_free_domains",
  })}) m
`;

const createIdentityFixtures = async (db: pg.Pool): Promise<void> => {
  await db.query(`
    create table tmp_ir_companies (
      company_id text primary key, name text not null, domain text not null,
      canonical_id text not null
    );
    create table tmp_ir_crm_emails (email text not null, company_id text not null);
    create table tmp_ir_entities (
      source text not null, source_entity_id text not null,
      email text not null, domain text not null, name text not null
    );
    -- Fixture table with stg_sheets__rows' column surface (staging is unit-pinned above;
    -- these tests isolate the IDENTITY arm over controlled candidate rows).
    create table tmp_sheet_rows (
      row_key text primary key, client_email text, client_name text, company_name text,
      amount_cents bigint, currency text, status text, label text, content_hash text,
      client_key text not null, detected_at timestamptz not null, received_at timestamptz not null
    );
    create table tmp_free_domains (domain text primary key);
    create view tmp_canonical as select company_id, canonical_id from tmp_ir_companies;
    create view tmp_stg_companies as
      select company_id, name, domain, null::text as owner_email from tmp_ir_companies;
    create view tmp_stg_contacts as select email, company_id from tmp_ir_crm_emails;
    create view tmp_stg_billing as
      select source_entity_id as customer_id, email, domain, name
      from tmp_ir_entities where source = 'billing';
    create view tmp_stg_support as
      select source_entity_id as requester_id, email as requester_email, domain,
             name as company_name
      from tmp_ir_entities where source = 'support';
  `);
};

/** Insert a sheet fixture row the way staging would emit it (client_key derived the same
 *  way staging derives it — the pin for THAT derivation lives in the staging suite). */
const seedSheetRow = async (
  db: pg.Pool,
  rowKey: string,
  opts: { email?: string; clientName?: string; company?: string; detectedAt: string; receivedAt?: string },
): Promise<void> => {
  const usable = opts.email !== undefined && opts.email.trim() !== "";
  const clientKey = usable ? `email:${opts.email!.trim().toLowerCase()}` : `row:${rowKey}`;
  await db.query(
    `insert into tmp_sheet_rows
       (row_key, client_email, client_name, company_name, content_hash, client_key, detected_at, received_at)
     values ($1, $2, $3, $4, 'feedfeedfeedfeed', $5, $6::timestamptz, coalesce($7, $6)::timestamptz)`,
    [rowKey, opts.email ?? null, opts.clientName ?? null, opts.company ?? null, clientKey, opts.detectedAt, opts.receivedAt ?? null],
  );
};

const resolveIdentity = async (db: pg.Pool) =>
  (await db.query(`${IDENTITY_SQL} order by source, source_entity_id`)).rows;

describe("A6 pair 1 — identity: sheets clients through the three tiers", () => {
  beforeEach(async () => {
    await createIdentityFixtures(pool);
  });

  it("tier 1: a sheet client whose email is CRM contact evidence resolves to the canonical company — one resolution row keyed 'email:<addr>'", async () => {
    await pool.query(`insert into tmp_ir_companies values ('C-A', 'Acme Group', 'acme.example.com', 'C-A')`);
    await pool.query(`insert into tmp_ir_crm_emails values ('jane@acme.example.com', 'C-A')`);
    await seedSheetRow(pool, "rk-0001", { email: "jane@acme.example.com", company: "Acme Group", detectedAt: "2026-07-28T10:00:00Z" });

    const rows = await resolveIdentity(pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "sheets",
      source_entity_id: "email:jane@acme.example.com",
      resolved_entity_id: "C-A",
      matched_tier: 1,
      match_evidence: "email=jane@acme.example.com",
    });
  });

  it("STRADDLE PIN (L2-G3): two same-email rows with DIFFERING company spellings collapse to ONE candidate tuple (latest-state evidence) BEFORE the tiers — the winner is the later row's evidence, deterministically", async () => {
    // Two canonicals share a domain but differ by name; un-collapsed, the two spellings
    // would enter tier 2 as two tuples, each matching a DIFFERENT canonical — the exact
    // multi-tuple straddle shape, resolved by an arbitrary plan-dependent pick. Collapsed,
    // only the LATEST row's spelling reaches tier 2.
    await pool.query(`
      insert into tmp_ir_companies values
        ('C-A', 'Acme Group', 'acme.example.com', 'C-A'),
        ('C-B', 'Acme Holdings', 'acme.example.com', 'C-B')
    `);
    await seedSheetRow(pool, "rk-0001", { email: "ops@acme.example.com", company: "Acme Group", detectedAt: "2026-07-28T10:00:00Z" });
    await seedSheetRow(pool, "rk-0002", { email: "ops@acme.example.com", company: "Acme Holdings", detectedAt: "2026-07-28T10:00:05Z" });

    const rows = await resolveIdentity(pool);
    expect(rows).toHaveLength(1); // ONE candidate per client email — no straddle
    expect(rows[0]).toMatchObject({
      source: "sheets",
      source_entity_id: "email:ops@acme.example.com",
      resolved_entity_id: "C-B", // the LATEST row's evidence decided, not an arbitrary pick
      matched_tier: 2,
      match_evidence: "domain+name=acme.example.com|acme holdings",
    });
  });

  it("straddle collapse is ms-tie-safe: same detected_at, later received_at wins the evidence pick", async () => {
    await pool.query(`
      insert into tmp_ir_companies values
        ('C-A', 'Acme Group', 'acme.example.com', 'C-A'),
        ('C-B', 'Acme Holdings', 'acme.example.com', 'C-B')
    `);
    const t = "2026-07-28T10:00:00.123Z";
    await seedSheetRow(pool, "rk-0001", { email: "ops@acme.example.com", company: "Acme Group", detectedAt: t, receivedAt: "2026-07-28T10:00:00.200Z" });
    await seedSheetRow(pool, "rk-0002", { email: "ops@acme.example.com", company: "Acme Holdings", detectedAt: t, receivedAt: "2026-07-28T10:00:00.300Z" });

    const rows = await resolveIdentity(pool);
    expect(rows).toHaveLength(1);
    expect(rows[0].resolved_entity_id).toBe("C-B");
  });

  it("no-email rows go to tier-3 manual review — EACH row its own entity, never guessed into a merge even when the company name matches a canonical exactly", async () => {
    await pool.query(`insert into tmp_ir_companies values ('C-A', 'Acme Group', 'acme.example.com', 'C-A')`);
    await seedSheetRow(pool, "rk-0001", { company: "Acme Group", detectedAt: "2026-07-28T10:00:00Z" });
    await seedSheetRow(pool, "rk-0002", { company: "Acme Group", detectedAt: "2026-07-28T10:00:01Z" });

    const rows = await resolveIdentity(pool);
    expect(rows).toHaveLength(2);
    for (const [i, rowKey] of (["rk-0001", "rk-0002"] as const).entries()) {
      expect(rows[i]).toMatchObject({
        source: "sheets",
        source_entity_id: `row:${rowKey}`,
        resolved_entity_id: `sheets:row:${rowKey}`,
        matched_tier: 3,
        match_evidence: "unmatched",
      });
    }
  });

  it("tier 2 via the email's own domain: no CRM contact match, but corporate email domain + company name resolve — and the tier-2 over-merge guard still bites sheets candidates", async () => {
    await pool.query(`insert into tmp_ir_companies values ('C-A', 'Acme Group', 'acme.example.com', 'C-A')`);
    // Resolves: domain from billing@acme.example.com + normalized name match.
    await seedSheetRow(pool, "rk-0001", { email: "billing@acme.example.com", company: "ACME GROUP Inc.", detectedAt: "2026-07-28T10:00:00Z" });

    const rows = await resolveIdentity(pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resolved_entity_id: "C-A",
      matched_tier: 2,
      match_evidence: "domain+name=acme.example.com|acme group",
    });

    // Guard regression inside the same fixture: a second canonical with the same
    // normalized domain+name makes the match AMBIGUOUS → tier 3, never a winner.
    await pool.query(`insert into tmp_ir_companies values ('C-Z', 'Acme Group LLC', 'acme.example.com', 'C-Z')`);
    const ambiguous = await resolveIdentity(pool);
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].matched_tier).toBe(3);
    expect(ambiguous[0].match_evidence).toContain("ambiguous");
  });

  it("an unmatched EMAIL client lands in tier 3 keyed 'sheets:email:<addr>' — the manual_review flow shape, unchanged", async () => {
    await seedSheetRow(pool, "rk-0001", { email: "stranger@nowhere.example.com", company: "Nowhere Co", detectedAt: "2026-07-28T10:00:00Z" });

    const rows = await resolveIdentity(pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_entity_id: "email:stranger@nowhere.example.com",
      resolved_entity_id: "sheets:email:stranger@nowhere.example.com",
      matched_tier: 3,
      match_evidence: "unmatched",
    });
  });

  it("regression: billing and support arms resolve EXACTLY as before beside the sheets arm — the source extension restructured nothing", async () => {
    await pool.query(`insert into tmp_ir_companies values ('C-A', 'Acme Group', 'acme.example.com', 'C-A')`);
    await pool.query(`insert into tmp_ir_crm_emails values ('jane@acme.example.com', 'C-A')`);
    await pool.query(`insert into tmp_ir_entities values ('billing', 'B-1', 'jane@acme.example.com', 'unrelated.example.com', 'Other')`);
    await pool.query(`insert into tmp_ir_entities values ('support', 'S-1', 'help@nowhere.example.com', 'acme.example.com', 'Totally Different Name')`);
    await seedSheetRow(pool, "rk-0001", { email: "jane@acme.example.com", company: "Acme Group", detectedAt: "2026-07-28T10:00:00Z" });

    const rows = await resolveIdentity(pool);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.source === "billing")).toMatchObject({ resolved_entity_id: "C-A", matched_tier: 1 });
    expect(rows.find((r) => r.source === "support")).toMatchObject({ resolved_entity_id: "support:S-1", matched_tier: 3 });
    expect(rows.find((r) => r.source === "sheets")).toMatchObject({ resolved_entity_id: "C-A", matched_tier: 1 });
  });
});

// ── A6 pair 2 — customer_360: sheet columns under the per-source currency machinery ──────

// The REAL mart, loaded from disk (now 10 refs → tmp_ fixtures) — no mirror to drift.
const MART_SQL = loadModel("models/marts/customer_360.sql", {
  int_crm__canonical_companies: "tmp_canonical",
  stg_crm__companies: "tmp_companies",
  identity_resolution: "tmp_resolution",
  stg_billing__customers: "tmp_billing_customers",
  stg_support__tickets: "tmp_tickets",
  stg_crm__deals: "tmp_deals",
  stg_billing__invoices: "tmp_invoices",
  stg_billing__payments: "tmp_payments",
  stg_support__csat: "tmp_csat",
  stg_sheets__rows: "tmp_sheet_rows",
});

const createMartFixtures = async (db: pg.Pool): Promise<void> => {
  await db.query(`
    create table tmp_canonical (company_id text primary key, canonical_id text not null);
    create table tmp_companies (company_id text primary key, name text not null, domain text);
    create table tmp_resolution (
      source text not null, source_entity_id text not null,
      resolved_entity_id text not null, matched_tier int not null
    );
    create table tmp_billing_customers (customer_id text primary key, name text, domain text);
    create table tmp_tickets (
      ticket_id text, requester_id text, company_name text, domain text,
      status text, solved_at timestamptz, sla_due_at timestamptz
    );
    create table tmp_deals (deal_id text, company_id text, status text, amount_cents bigint, currency text);
    create table tmp_invoices (invoice_id text, customer_id text, amount_cents bigint, status text, currency text);
    create table tmp_payments (customer_id text, status text);
    create table tmp_csat (ticket_id text, score int);
    create table tmp_sheet_rows (
      row_key text primary key, client_email text, client_name text, company_name text,
      amount_cents bigint, currency text, status text, label text, content_hash text,
      client_key text not null, detected_at timestamptz not null default now(),
      received_at timestamptz not null default now()
    );
  `);
};

/** One CRM entity (self-canonical) with a sheets resolution link for clientKey. */
const seedSheetEntity = async (db: pg.Pool, companyId: string, clientKey: string): Promise<void> => {
  await db.query("insert into tmp_canonical values ($1, $1)", [companyId]);
  await db.query("insert into tmp_companies values ($1, $2, $3)", [
    companyId, `Co ${companyId}`, `${companyId.toLowerCase()}.example.com`,
  ]);
  await db.query("insert into tmp_resolution values ('sheets', $1, $2, 1)", [clientKey, companyId]);
};

const seedSheetFixtureRow = async (
  db: pg.Pool,
  rowKey: string,
  clientKey: string,
  opts: { amount?: number | null; currency?: string | null; clientName?: string; company?: string } = {},
): Promise<void> => {
  await db.query(
    `insert into tmp_sheet_rows (row_key, client_email, client_name, company_name, amount_cents, currency, client_key)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      rowKey,
      clientKey.startsWith("email:") ? clientKey.slice(6) : null,
      opts.clientName ?? null,
      opts.company ?? null,
      opts.amount ?? null,
      opts.currency ?? null,
      clientKey,
    ],
  );
};

const martRow = async (db: pg.Pool, entityId: string): Promise<Record<string, unknown>> => {
  const res = await db.query(`select * from (${MART_SQL}) m where entity_id = $1`, [entityId]);
  expect(res.rowCount).toBe(1);
  return res.rows[0];
};

describe("A6 pair 2 — customer_360 sheet columns: own columns, per-source currency rules", () => {
  beforeEach(async () => {
    await createMartFixtures(pool);
  });

  it("sheet sums NEVER fold into deal/invoice sums: an entity with deals + invoices + sheet rows keeps three separate figures", async () => {
    await seedSheetEntity(pool, "C-1", "email:jane@c-1.example.com");
    await pool.query("insert into tmp_resolution values ('billing', 'cust-1', 'C-1', 1)");
    await pool.query(`
      insert into tmp_deals values ('d-1', 'C-1', 'open', 30000, 'USD');
      insert into tmp_invoices values ('inv-1', 'cust-1', 20000, 'paid', 'USD');
    `);
    await seedSheetFixtureRow(pool, "rk-0001", "email:jane@c-1.example.com", { amount: 5000, currency: "USD" });
    await seedSheetFixtureRow(pool, "rk-0002", "email:jane@c-1.example.com", { amount: 7000, currency: "USD" });

    const row = await martRow(pool, "C-1");
    expect(row.open_deal_amount_cents).toBe("30000"); // NOT 42000 — sheets folded nowhere
    expect(row.total_invoiced_cents).toBe("20000"); // NOT 32000
    expect(row.sheet_amount_cents).toBe("12000"); // the sheet book in its OWN column
    expect(Number(row.sheet_row_count)).toBe(2);
    expect(row.sheet_currency).toBe("USD");
    expect(row.has_sheets).toBe(true);
    expect(row.has_mixed_currency).toBe(false);
    expect(row.has_data_warnings).toBe(false);
  });

  it("has_sheets flag + the no-rows shape: an entity with no sheet link reads false / 0 / 0 / NULL — 0 stays 'genuinely nothing'", async () => {
    await pool.query("insert into tmp_canonical values ('C-2', 'C-2')");
    await pool.query("insert into tmp_companies values ('C-2', 'Co C-2', 'c-2.example.com')");

    const row = await martRow(pool, "C-2");
    expect(row.has_sheets).toBe(false);
    expect(Number(row.sheet_row_count)).toBe(0);
    expect(row.sheet_amount_cents).toBe("0"); // no rows = a true 0, not NULL
    expect(row.sheet_currency).toBeNull();
    expect(Number(row.null_amount_sheet_count)).toBe(0);
    expect(Number(row.null_currency_sheet_count)).toBe(0);
  });

  it("ISOLATING PIN — sheet mixed currency: two KNOWN currencies and nothing else anywhere; ONLY the sheet-mixed OR term fires (its deletion fails exactly here)", async () => {
    await seedSheetEntity(pool, "C-3", "email:ops@c-3.example.com");
    await seedSheetFixtureRow(pool, "rk-0001", "email:ops@c-3.example.com", { amount: 5000, currency: "USD" });
    await seedSheetFixtureRow(pool, "rk-0002", "email:ops@c-3.example.com", { amount: 7000, currency: "EUR" });

    const row = await martRow(pool, "C-3");
    expect(row.sheet_amount_cents).toBeNull(); // 5000+7000 across USD/EUR is a lie
    expect(row.sheet_currency).toBeNull();
    expect(row.has_mixed_currency).toBe(true); // ← the term under isolation
    expect(row.has_data_warnings).toBe(true); // ← and its warnings OR arm
    // Every OTHER honesty signal is provably silent:
    expect(row.has_unusable_amounts).toBe(false);
    expect(Number(row.null_currency_sheet_count)).toBe(0);
    expect(Number(row.null_amount_sheet_count)).toBe(0);
    expect(Number(row.null_currency_invoice_count) + Number(row.null_currency_deal_count)).toBe(0);
    expect(Number(row.null_score_count)).toBe(0);
  });

  it("ISOLATING PIN — sheet unusable amount: one NULL-amount sheet row (currency known, all other sources clean); ONLY the sheet term of has_unusable_amounts fires", async () => {
    await seedSheetEntity(pool, "C-4", "email:ops@c-4.example.com");
    await seedSheetFixtureRow(pool, "rk-0001", "email:ops@c-4.example.com", { amount: 5000, currency: "USD" });
    await seedSheetFixtureRow(pool, "rk-0002", "email:ops@c-4.example.com", { amount: null, currency: "USD" });

    const row = await martRow(pool, "C-4");
    expect(row.has_unusable_amounts).toBe(true); // ← the term under isolation
    expect(row.has_data_warnings).toBe(true);
    expect(Number(row.null_amount_sheet_count)).toBe(1);
    // The usable rows still sum (single currency, unknown-currency rows absent):
    expect(row.sheet_amount_cents).toBe("5000");
    expect(row.sheet_currency).toBe("USD");
    // Every OTHER signal silent — deleting the sheet term flips has_unusable_amounts
    // AND has_data_warnings false here, failing exactly this test:
    expect(row.has_mixed_currency).toBe(false);
    expect(Number(row.null_amount_deal_count)).toBe(0);
    expect(Number(row.null_amount_invoice_count)).toBe(0);
    expect(Number(row.null_currency_sheet_count)).toBe(0);
  });

  it("ISOLATING PIN — sheet unknown currency: uniformly-NULL currency refuses the sum WITHOUT being mixed; ONLY the null_currency_sheet term of has_data_warnings fires", async () => {
    await seedSheetEntity(pool, "C-5", "email:ops@c-5.example.com");
    await seedSheetFixtureRow(pool, "rk-0001", "email:ops@c-5.example.com", { amount: 5000, currency: null });
    await seedSheetFixtureRow(pool, "rk-0002", "email:ops@c-5.example.com", { amount: 7000, currency: null });

    const row = await martRow(pool, "C-5");
    expect(row.sheet_amount_cents).toBeNull(); // unknown units are counted, never totaled
    expect(row.sheet_currency).toBeNull();
    expect(Number(row.null_currency_sheet_count)).toBe(2); // the visible bucket
    expect(row.has_data_warnings).toBe(true); // ← reachable ONLY through the new term here
    // All-unknown is refused-but-NOT-mixed, and no other signal fires:
    expect(row.has_mixed_currency).toBe(false);
    expect(row.has_unusable_amounts).toBe(false);
    expect(Number(row.null_amount_sheet_count)).toBe(0);
  });

  it("F2 analog for sheets: a known currency plus an unknown one (USD + NULL) is MIXED — sum refused, flag true, unknown row counted", async () => {
    await seedSheetEntity(pool, "C-6", "email:ops@c-6.example.com");
    await seedSheetFixtureRow(pool, "rk-0001", "email:ops@c-6.example.com", { amount: 5000, currency: "USD" });
    await seedSheetFixtureRow(pool, "rk-0002", "email:ops@c-6.example.com", { amount: 7000, currency: null });

    const row = await martRow(pool, "C-6");
    expect(row.sheet_amount_cents).toBeNull();
    expect(row.sheet_currency).toBeNull(); // 'USD' is not the whole truth
    expect(row.has_mixed_currency).toBe(true);
    expect(Number(row.null_currency_sheet_count)).toBe(1);
  });

  it("a keyless tier-3 sheet row is a mart row of its OWN — never hidden, named from its latest sheet evidence, flagged incomplete", async () => {
    await pool.query("insert into tmp_resolution values ('sheets', 'row:rk-0009', 'sheets:row:rk-0009', 3)");
    await seedSheetFixtureRow(pool, "rk-0009", "row:rk-0009", { amount: 9000, currency: "USD", clientName: "Jane Doe" });

    const row = await martRow(pool, "sheets:row:rk-0009");
    expect(row.has_crm).toBe(false);
    expect(row.is_complete).toBe(false); // D6: present but visibly incomplete
    expect(row.has_sheets).toBe(true);
    expect(row.entity_name).toBe("Jane Doe"); // sheet evidence names the orphan
    expect(Number(row.sheet_row_count)).toBe(1);
    expect(row.sheet_amount_cents).toBe("9000");
  });

  // Debt-burn C2 companion (register, owner Task F): the NAMED orphan-domain assertion.
  // The behavior landed with the burn wave (mart derives a sheets orphan's domain from
  // its own email; dbt singular test assert_sheet_orphan_domains_derived guards the
  // model-level invariant); this test pins it BY NAME in the suite that owns the sheets
  // arm, including the free-email caveat: on the MART the derived domain is a carried
  // display attribute — it appears even for a free provider, because identity_resolution
  // (not the mart) is where the blocklist refuses it as MERGE evidence.
  it("C2 companion — orphan-domain derivation, named: an email-keyed tier-3 orphan carries the domain split from its own address (even a free provider — display attribute, not merge evidence); a row-keyed orphan keeps NULL, never guessed", async () => {
    await pool.query("insert into tmp_resolution values ('sheets', 'email:pat@freemail.example.com', 'sheets:email:pat@freemail.example.com', 3)");
    await seedSheetFixtureRow(pool, "rk-0010", "email:pat@freemail.example.com", { clientName: "Pat Doe", company: "Pat Doe Plumbing" });
    await pool.query("insert into tmp_resolution values ('sheets', 'row:rk-0011', 'sheets:row:rk-0011', 3)");
    await seedSheetFixtureRow(pool, "rk-0011", "row:rk-0011", { clientName: "Keyless Kay" });

    const emailOrphan = await martRow(pool, "sheets:email:pat@freemail.example.com");
    expect(emailOrphan.domain).toBe("freemail.example.com"); // derived from its OWN email, verbatim
    const keylessOrphan = await martRow(pool, "sheets:row:rk-0011");
    expect(keylessOrphan.domain).toBeNull(); // no usable email → NULL kept, never guessed
  });
});

// ── A6 pair 2 — the extended singular test's own predicate ───────────────────────────────

const SINGULAR_SQL = loadModel("tests/assert_no_mixed_currency_totals.sql", {
  customer_360: "tmp_mart",
  identity_resolution: "tmp_resolution",
  stg_billing__invoices: "tmp_invoices",
  stg_crm__deals: "tmp_deals",
  int_crm__canonical_companies: "tmp_canonical",
  stg_sheets__rows: "tmp_sheet_rows",
});

describe("A6 pair 2 — assert_no_mixed_currency_totals gains a sheets CTE (same per-source predicate)", () => {
  beforeEach(async () => {
    await createMartFixtures(pool);
  });

  it("returns ZERO rows against a correct mart carrying a mixed-sheet entity (its sum is already NULL) — and the neighbor sources are untouched", async () => {
    await seedSheetEntity(pool, "C-7", "email:ops@c-7.example.com");
    await seedSheetFixtureRow(pool, "rk-0001", "email:ops@c-7.example.com", { amount: 5000, currency: "USD" });
    await seedSheetFixtureRow(pool, "rk-0002", "email:ops@c-7.example.com", { amount: 7000, currency: "EUR" });

    await pool.query(`create table tmp_mart as ${MART_SQL}`);
    const res = await pool.query(SINGULAR_SQL);
    expect(res.rows).toEqual([]);
  });

  it("planted counter-example: a corrupted mart where a mixed-sheet entity carries a non-NULL sheet_amount_cents IS returned as mixed_source 'sheets' — the extended test can fail", async () => {
    await seedSheetEntity(pool, "C-8", "email:ops@c-8.example.com");
    await seedSheetFixtureRow(pool, "rk-0001", "email:ops@c-8.example.com", { amount: 5000, currency: "USD" });
    await seedSheetFixtureRow(pool, "rk-0002", "email:ops@c-8.example.com", { amount: 7000, currency: null }); // known + unknown (F2)

    await pool.query(`create table tmp_mart as ${MART_SQL}`);
    await pool.query(`update tmp_mart set sheet_amount_cents = 999999 where entity_id = 'C-8'`);

    const res = await pool.query(SINGULAR_SQL);
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].entity_id).toBe("C-8");
    expect(res.rows[0].mixed_source).toBe("sheets"); // mixing re-derived from staging, not the mart's flag
  });
});

// ── A6 pair 3 — the stage-2 oracle: sheet ⇄ mart over the REAL chained warehouse SQL ─────

// The full warehouse DAG, chained as views in the ephemeral db — every model's REAL text
// (loadModel), refs resolved to the sibling views by their own names. This is the A5
// in-process pattern extended one layer down: connector output in raw is consumed by the
// same SQL dbt builds in CI.
const chainWarehouse = async (db: pg.Pool): Promise<void> => {
  const staging = [
    "stg_crm__companies", "stg_crm__contacts", "stg_crm__deals",
    "stg_billing__customers", "stg_billing__invoices", "stg_billing__payments",
    "stg_support__tickets", "stg_support__csat", "stg_sheets__rows",
  ];
  for (const m of staging) await db.query(`create view ${m} as ${loadModel(`models/staging/${m}.sql`)}`);
  await db.query(`create view merge_edges as ${loadModel("models/identity/merge_edges.sql")}`);
  await db.query(`create view int_crm__canonical_companies as ${loadModel("models/identity/int_crm__canonical_companies.sql", {
    stg_crm__companies: "stg_crm__companies", merge_edges: "merge_edges",
  })}`);
  // The blocklist seed rides the chain as an empty relation: the manifest universe is
  // corporate-domain by construction, so the stage-2 oracle exercises the mechanism's
  // pass-through side; the demotion side is unit-pinned in free-email-blocklist.test.ts.
  await db.query(`create table free_email_domains (domain text primary key)`);
  await db.query(`create view identity_resolution as ${loadModel("models/identity/identity_resolution.sql", {
    int_crm__canonical_companies: "int_crm__canonical_companies",
    stg_crm__companies: "stg_crm__companies",
    stg_crm__contacts: "stg_crm__contacts",
    stg_billing__customers: "stg_billing__customers",
    stg_support__tickets: "stg_support__tickets",
    stg_sheets__rows: "stg_sheets__rows",
    free_email_domains: "free_email_domains",
  })}`);
  await db.query(`create view customer_360 as ${loadModel("models/marts/customer_360.sql", {
    int_crm__canonical_companies: "int_crm__canonical_companies",
    stg_crm__companies: "stg_crm__companies",
    identity_resolution: "identity_resolution",
    stg_billing__customers: "stg_billing__customers",
    stg_support__tickets: "stg_support__tickets",
    stg_crm__deals: "stg_crm__deals",
    stg_billing__invoices: "stg_billing__invoices",
    stg_billing__payments: "stg_billing__payments",
    stg_support__csat: "stg_support__csat",
    stg_sheets__rows: "stg_sheets__rows",
  })}`);
};

function startSheet(opts?: Partial<SheetsAppOptions>): { sheets: SheetsApp; baseUrl: string } {
  const sheets = createSheetsApp({ seed: 7, rowCount: 6, ...opts });
  srv = sheets.app.listen(0);
  const port = (srv.address() as { port: number }).port;
  return { sheets, baseUrl: `http://127.0.0.1:${port}` };
}

const mkConnector = (baseUrl: string): SheetSnapshotConnector =>
  new SheetSnapshotConnector({ baseUrl, timeoutMs: 3000, backoff: { baseMs: 5, capMs: 50, maxAttempts: 6 } });

// The door-refusal expectation, deliberately RE-STATED (A5's rationale: an expectation
// computed by the code under test would follow that code into any regression): the L1
// contract for the two ruled sheet fields — amount_cents strict shapes and ^[A-Z]{3}$
// currency; empty cells are ABSENT and never fail anything.
const AMOUNT_OK = /^\d{1,13}(\.\d{1,2})?$/;
const CURRENCY_OK = /^[A-Z]{3}$/;
const doorFailure = (content: Record<string, string>): string | null => {
  if (content.amount_cents !== undefined && !AMOUNT_OK.test(content.amount_cents.trim())) return "amount_cents";
  if (content.currency !== undefined && !CURRENCY_OK.test(content.currency)) return "currency";
  return null;
};
/** Independently re-stated cents parse (whole*100 + 2-padded fraction, integer math). */
const centsOf = (raw: string): number => {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim())!;
  return Number(m[1]) * 100 + (m[2] === undefined ? 0 : Number(m[2].padEnd(2, "0")));
};
/** The staging client_key rule, re-stated: usable email → 'email:'+lower(trim); else row-keyed. */
const clientKeyOf = (rowKey: string, content: Record<string, string>): string =>
  content.email !== undefined && content.email.trim() !== ""
    ? `email:${content.email.trim().toLowerCase()}`
    : `row:${rowKey}`;

function sheetTruth(sheets: SheetsApp): { rowKey: string; content: Record<string, string>; hash: string; failure: string | null }[] {
  const grid = sheets.sheet.values();
  const mapping = resolveHeaderMapping(grid.header);
  return sheets.sheet.metadata().map(({ rowKey, rowIndex }) => {
    const content = canonicalRowContent(mapping, grid.rows[rowIndex]);
    return { rowKey, content, hash: contentHash(content), failure: doorFailure(content) };
  });
}

const manifest = generateManifest(42);
let crmEvt = 0;
const insertCrmRaw = async (db: pg.Pool, eventType: string, data: Record<string, unknown>): Promise<void> => {
  await db.query(
    `insert into raw.raw_events (source, event_id, event_type, payload)
     values ('crm', $1, $2, $3::jsonb)`,
    [`evt-${90000 + ++crmEvt}`, eventType, JSON.stringify({ occurred_at: "2026-07-20T00:00:00.000Z", data })],
  );
};
/** The whole manifest CRM universe as raw events — the same people/companies the sheet
 *  mock draws its rows from (master seed 42), so per-client resolution has real targets. */
const seedCrmUniverse = async (db: pg.Pool): Promise<void> => {
  for (const c of manifest.crm.companies)
    await insertCrmRaw(db, "company.updated", { id: c.id, name: c.name, domain: c.domain, owner_email: c.owner_email });
  for (const ct of manifest.crm.contacts)
    await insertCrmRaw(db, "contact.updated", { id: ct.id, company_id: ct.company_id, name: ct.name, email: ct.email });
};

type MartRow = Record<string, unknown>;
const martRows = async (db: pg.Pool): Promise<MartRow[]> =>
  (await db.query("select * from customer_360")).rows;
const chainedStagingRows = async (db: pg.Pool): Promise<Record<string, unknown>[]> =>
  (await db.query("select * from stg_sheets__rows order by row_key")).rows;
const sheetResolution = async (db: pg.Pool): Promise<Record<string, unknown>[]> =>
  (await db.query("select * from identity_resolution where source = 'sheets'")).rows;

/** Mart ⇄ staging closure with the summability rule RE-STATED: for every entity, the
 *  sheet counters/sums must equal an independent aggregation of its staged rows (staging
 *  itself is closed against the sheet row-wise by the callers). Also conservation: every
 *  staged row reaches EXACTLY one mart entity. */
const expectMartMatchesStaging = async (db: pg.Pool): Promise<void> => {
  const staged = await chainedStagingRows(db);
  const resolution = await sheetResolution(db);
  // Every staged client_key resolves exactly once.
  const byKey = new Map<string, string>();
  for (const r of resolution) byKey.set(r.source_entity_id as string, r.resolved_entity_id as string);
  const keys = new Set(staged.map((s) => s.client_key as string));
  expect([...keys].filter((k) => !byKey.has(k))).toEqual([]);

  const perEntity = new Map<string, Record<string, unknown>[]>();
  for (const s of staged) {
    const entity = byKey.get(s.client_key as string)!;
    perEntity.set(entity, [...(perEntity.get(entity) ?? []), s]);
  }
  const mart = await martRows(db);
  let counted = 0;
  for (const m of mart) {
    const rows = perEntity.get(m.entity_id as string) ?? [];
    expect(m.has_sheets, `entity ${m.entity_id}: has_sheets vs staged rows`).toBe(rows.length > 0);
    expect(Number(m.sheet_row_count)).toBe(rows.length);
    counted += rows.length;
    const nullCur = rows.filter((r) => r.currency === null).length;
    const nullAmt = rows.filter((r) => r.amount_cents === null).length;
    expect(Number(m.null_currency_sheet_count)).toBe(nullCur);
    expect(Number(m.null_amount_sheet_count)).toBe(nullAmt);
    const known = new Set(rows.map((r) => r.currency).filter((c) => c !== null));
    const summable = known.size <= 1 && nullCur === 0;
    if (rows.length === 0 || (summable && rows.length > 0)) {
      const sum = rows.reduce((n, r) => n + (r.amount_cents === null ? 0 : Number(r.amount_cents)), 0);
      expect(m.sheet_amount_cents, `entity ${m.entity_id}: summable sheet sum`).toBe(String(sum));
    } else {
      expect(m.sheet_amount_cents, `entity ${m.entity_id}: refused sheet sum`).toBeNull();
    }
  }
  expect(counted).toBe(staged.length); // conservation: nothing dropped, nothing double-counted
};

describe("A6 pair 3 — stage-2 oracle: sheet ⇄ mart", () => {
  it("calm run over the manifest universe: every sheet client tier-1 resolves to its manifest company and the mart's sheet columns equal hand-computed truth", async () => {
    await seedCrmUniverse(pool);
    const { sheets, baseUrl } = startSheet();
    const c = mkConnector(baseUrl);
    await c.catchUp(pool);
    for (let i = 1; i <= 8; i++) {
      sheets.editor.applyStep("calm");
      if (i % 4 === 0) await c.catchUp(pool);
    }
    await c.catchUp(pool);
    await chainWarehouse(pool);

    const truth = sheetTruth(sheets);
    expect(truth.every((r) => r.failure === null)).toBe(true); // calm: nothing refused

    // Manifest expectations: email → unique contact → company (skip nothing silently —
    // assert every sheet email exists exactly once in the manifest universe).
    const emailToCompany = new Map<string, string>();
    for (const ct of manifest.crm.contacts) {
      expect(emailToCompany.has(ct.email)).toBe(false);
      emailToCompany.set(ct.email, ct.company_id);
    }
    const expectedByCompany = new Map<string, { rows: number; cents: number }>();
    for (const r of truth) {
      const company = emailToCompany.get(r.content.email!);
      expect(company, `sheet email ${r.content.email} must exist in the manifest`).toBeDefined();
      const agg = expectedByCompany.get(company!) ?? { rows: 0, cents: 0 };
      agg.rows += 1;
      agg.cents += centsOf(r.content.amount_cents!);
      expectedByCompany.set(company!, agg);
    }
    expect(expectedByCompany.size).toBeGreaterThanOrEqual(3); // the oracle checked something real

    const resolution = await sheetResolution(pool);
    expect(resolution).toHaveLength(new Set(truth.map((r) => r.content.email!.toLowerCase())).size);
    for (const r of resolution) {
      expect(r.matched_tier).toBe(1); // manifest contact emails are tier-1 evidence
      const email = (r.source_entity_id as string).replace(/^email:/, "");
      expect(r.resolved_entity_id).toBe(emailToCompany.get(email));
    }

    const mart = await martRows(pool);
    for (const [company, agg] of expectedByCompany) {
      const row = mart.find((m) => m.entity_id === company);
      expect(row, `mart row for ${company}`).toBeDefined();
      expect(row!.has_sheets).toBe(true);
      expect(row!.has_crm).toBe(true);
      expect(Number(row!.sheet_row_count)).toBe(agg.rows);
      expect(row!.sheet_amount_cents).toBe(String(agg.cents)); // calm = all-USD, summable
      expect(row!.sheet_currency).toBe("USD");
    }
    // And a company the sheet never mentioned has NO sheet presence:
    const untouched = mart.find((m) => m.has_crm === true && !expectedByCompany.has(m.entity_id as string));
    expect(untouched).toBeDefined();
    expect(untouched!.has_sheets).toBe(false);
    expect(untouched!.sheet_amount_cents).toBe("0");

    await expectMartMatchesStaging(pool);
  });

  for (const plan of ["messy", "hostile"] as const) {
    it(`${plan} run: CLEAN sheet rows ⇄ mart state exactly; quarantined-current rows' CURRENT content is excluded from staging AND the mart counters account for every staged row`, async () => {
      const { sheets, baseUrl } = startSheet({ seed: plan === "messy" ? 102 : 104, rowCount: 8 });
      const c = mkConnector(baseUrl);
      await c.catchUp(pool);
      for (let i = 1; i <= 24; i++) {
        sheets.editor.applyStep(plan);
        if (i % 4 === 0) await c.catchUp(pool);
      }
      await c.catchUp(pool);
      await chainWarehouse(pool);

      const truth = sheetTruth(sheets);
      const staged = await chainedStagingRows(pool);
      const stagedByKey = new Map(staged.map((s) => [s.row_key as string, s]));

      if (plan === "hostile") {
        // The rotation guarantees garbage: an all-clean hostile run would mean the
        // exclusion assertions below tested nothing.
        expect(truth.some((r) => r.failure !== null)).toBe(true);
      }

      for (const r of truth) {
        const s = stagedByKey.get(r.rowKey);
        if (r.failure === null) {
          // Clean current content: the final cycle landed it — staging IS the sheet.
          expect(s, `clean row ${r.rowKey} must be staged`).toBeDefined();
          expect(s!.content_hash).toBe(r.hash);
          expect(s!.client_email).toBe(r.content.email ?? null);
          expect(s!.client_name).toBe(r.content.client_name ?? null);
          expect(s!.company_name).toBe(r.content.company ?? null);
          expect(s!.label).toBe(r.content.deal ?? null);
          expect(s!.status).toBe(r.content.status ?? null);
          expect(s!.amount_cents).toBe(r.content.amount_cents === undefined ? null : String(centsOf(r.content.amount_cents)));
          expect(s!.currency).toBe(r.content.currency ?? null);
          expect(s!.client_key).toBe(clientKeyOf(r.rowKey, r.content));
        } else if (s !== undefined) {
          // Quarantined-current, stale shape: an OLDER clean version is live — the
          // current garbage content must NOT be what the mart consumes.
          expect(s.content_hash).not.toBe(r.hash);
        } // else: quarantined-current, missing shape — no version ever landed. Excluded.
      }
      // No phantoms: staging never carries a row the sheet does not currently have
      // (tombstones filter; deletes always land).
      const liveKeys = new Set(truth.map((r) => r.rowKey));
      expect(staged.filter((s) => !liveKeys.has(s.row_key as string))).toEqual([]);

      await expectMartMatchesStaging(pool); // counters make the exclusion visible + conservation
    });
  }

  it("tombstone pin, end-to-end: a deleted row leaves staging AND its client's mart row; re-adding the same content (new row birth) brings the client back", async () => {
    const { sheets, baseUrl } = startSheet({ rowCount: 4 });
    const c = mkConnector(baseUrl);
    // A manifest contact whose email is NOT already in the seeded sheet: the client's
    // mart presence is then owned entirely by the row we control.
    const seededEmails = new Set(sheetTruth(sheets).map((r) => r.content.email));
    const contact = manifest.crm.contacts.find((ct) => !seededEmails.has(ct.email))!;
    const company = manifest.crm.companies.find((co) => co.id === contact.company_id)!;
    const cells = [contact.name, contact.email, company.name, "Renewal", "150.00", "USD", "open", "2026-07-15", ""];
    sheets.sheet.apply({ type: "append_row", cells });
    await c.catchUp(pool);
    await chainWarehouse(pool);

    const entityId = `sheets:email:${contact.email}`; // CRM-free run: tier-3 identity
    const before = await martRows(pool);
    const mine = before.find((m) => m.entity_id === entityId);
    expect(mine).toBeDefined();
    expect(Number(mine!.sheet_row_count)).toBe(1);
    expect(mine!.sheet_amount_cents).toBe("15000");
    expect(mine!.entity_name).toBe(company.name); // named from sheet evidence, not hidden

    // Delete → the tombstone removes the row from staging, the client from resolution,
    // and therefore the ENTITY from the mart (its only evidence is gone).
    const rowKey = sheets.sheet.metadata()[sheets.sheet.rowCount() - 1].rowKey;
    sheets.sheet.apply({ type: "delete_row", rowKey });
    await c.catchUp(pool);
    const afterDelete = await martRows(pool);
    expect(afterDelete.find((m) => m.entity_id === entityId)).toBeUndefined();

    // Re-add the SAME content: metadata died with the row, so this is a new row birth
    // with a fresh key — it lands (content-addressed id is new) and the client returns.
    sheets.sheet.apply({ type: "append_row", cells });
    await c.catchUp(pool);
    const afterReadd = await martRows(pool);
    const back = afterReadd.find((m) => m.entity_id === entityId);
    expect(back).toBeDefined();
    expect(Number(back!.sheet_row_count)).toBe(1);
    expect(back!.sheet_amount_cents).toBe("15000");
  });
});
