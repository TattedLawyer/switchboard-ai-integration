import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { loadModel } from "./helpers/load-model.js";

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

beforeEach(async () => {
  ({ pool, cleanup } = await freshTestDb());
});
afterEach(async () => {
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
