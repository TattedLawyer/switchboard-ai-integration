import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { loadModel } from "./helpers/load-model.js";
import {
  insertCaseEvent,
  insertHubMergeEvent,
  insertHubObjectState,
  insertStripeEvent,
} from "./helpers/hub-staging.js";
import { createIso4217Fixture, createNumericBoundsFixture, ISO_4217_REF } from "./helpers/numeric-bounds.js";

// ── F-1c: the coordinated staging switch, pinned per arm ────────────────────────────────
//
// The warehouse flips to the faithful sources: the CRM arm stages from hubcrm hydrated
// snapshots sequenced by their triggering thin events (D7 — raw is metadata-only on
// this paradigm), merge lineage re-sources from `company.merge` events with BOTH inputs
// mapping to the NEW survivor (f2-wire-research.md Q1), the support arm stages from the
// casebus wire's supplied-* intake fields (Q2), and the billing arm re-shapes the
// stripefeed envelope vocabulary (finalized/charge) onto the warehouse's invoice/payment
// surface. Every pin here runs the REAL on-disk model text (loadModel, house rule B2).

let pool: pg.Pool;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ pool, cleanup } = await freshTestDb());
  // Wave 5 (Task G): the billing staging models join ref('numeric_bounds') — the
  // COMMITTED seed, materialized; inert for the other models loaded here.
  await createNumericBoundsFixture(pool);
  await createIso4217Fixture(pool);
});
afterEach(async () => {
  await cleanup();
});

const model = async (relPath: string): Promise<Record<string, unknown>[]> =>
  (await pool.query(`select * from (${loadModel(relPath, { numeric_bounds: "numeric_bounds", ...ISO_4217_REF })}) m`)).rows;

describe("stg_crm__companies — the hubcrm snapshot arm", () => {
  it("stages by hs_manifest_id from live objects' snapshots; the triggering event's occurred_at decides latest state, not arrival", async () => {
    // Object 111 = manifest C-A: created, then renamed... wait — properties are the
    // FETCHED state; two states for one object = two hydrated events.
    await insertHubObjectState(pool, {
      objectType: "company", objectId: 111, eventId: "9001",
      occurredAt: "2026-07-20T10:00:00.000Z",
      properties: { name: "DEMO A New", domain: "a.example.com", owner_email: "o@a.example.com", hs_manifest_id: "C-A" },
    });
    // Stale state, arrives LATER (out-of-order delivery): must not win.
    await insertHubObjectState(pool, {
      objectType: "company", objectId: 111, eventId: "9002", eventType: "company.propertyChange",
      occurredAt: "2026-07-19T10:00:00.000Z", receivedAt: new Date().toISOString(),
      properties: { name: "DEMO A Stale", domain: "a.example.com", owner_email: "o@a.example.com", hs_manifest_id: "C-A" },
    });
    const rows = await model("models/staging/stg_crm__companies.sql");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      company_id: "C-A",
      name: "DEMO A New",
      domain: "a.example.com",
      owner_email: "o@a.example.com",
    });
  });

  it("a tombstoned object (its newest hydration answered 404) contributes no staged row, and no NULL company_id row ever appears", async () => {
    await insertHubObjectState(pool, {
      objectType: "company", objectId: 222, eventId: "9010",
      occurredAt: "2026-07-20T10:00:00.000Z",
      properties: { name: "DEMO Gone", domain: "gone.example.com", hs_manifest_id: "C-GONE" },
    });
    await insertHubObjectState(pool, {
      objectType: "company", objectId: 222, eventId: "9011", eventType: "company.propertyChange",
      occurredAt: "2026-07-21T10:00:00.000Z", tombstone: true,
    });
    const rows = await model("models/staging/stg_crm__companies.sql");
    expect(rows).toHaveLength(0);
    const nulls = await pool.query(
      `select * from (${loadModel("models/staging/stg_crm__companies.sql")}) m where company_id is null`,
    );
    expect(nulls.rowCount).toBe(0);
  });

  it("two live objects claiming one business key (merge survivor beside a recycled create) collapse to the newest state", async () => {
    await insertHubObjectState(pool, {
      objectType: "company", objectId: 301, eventId: "9020",
      occurredAt: "2026-07-20T10:00:00.000Z",
      properties: { name: "DEMO Survivor", domain: "k.example.com", hs_manifest_id: "C-K", hs_merged_object_ids: "300;299" },
    });
    await insertHubObjectState(pool, {
      objectType: "company", objectId: 302, eventId: "9021",
      occurredAt: "2026-07-21T10:00:00.000Z",
      properties: { name: "DEMO Recycled", domain: "k.example.com", hs_manifest_id: "C-K" },
    });
    const rows = await model("models/staging/stg_crm__companies.sql");
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("DEMO Recycled");
  });
});

describe("stg_crm__contacts / stg_crm__deals — the hubcrm snapshot arms", () => {
  it("contacts stage identity from snapshot properties (contact_id = hs_manifest_id, company linkage = company_manifest_id)", async () => {
    await insertHubObjectState(pool, {
      objectType: "contact", objectId: 401, eventId: "9030",
      occurredAt: "2026-07-20T10:00:00.000Z",
      properties: { name: "DEMO Jane", email: "jane@a.example.com", company_manifest_id: "C-A", hs_manifest_id: "P-1" },
    });
    const rows = await model("models/staging/stg_crm__contacts.sql");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contact_id: "P-1", company_id: "C-A", email: "jane@a.example.com" });
  });

  it("deals cast the vendor's digit-string amount, NULL malformed amounts and non-code currencies, and drop deleted (tombstoned) deals", async () => {
    await insertHubObjectState(pool, {
      objectType: "deal", objectId: 501, eventId: "9040",
      occurredAt: "2026-07-20T10:00:00.000Z",
      properties: { name: "DEMO Deal 1", amount_cents: "125000", currency: "USD", status: "open", company_manifest_id: "C-A", hs_manifest_id: "D-1" },
    });
    await insertHubObjectState(pool, {
      objectType: "deal", objectId: 502, eventId: "9041",
      occurredAt: "2026-07-20T11:00:00.000Z",
      properties: { name: "DEMO Deal 2", amount_cents: "not-a-number", currency: "usd", status: "open", company_manifest_id: "C-A", hs_manifest_id: "D-2" },
    });
    await insertHubObjectState(pool, {
      objectType: "deal", objectId: 503, eventId: "9042",
      occurredAt: "2026-07-20T12:00:00.000Z",
      properties: { name: "DEMO Deal 3", amount_cents: "1", currency: "USD", status: "open", company_manifest_id: "C-A", hs_manifest_id: "D-3" },
    });
    await insertHubObjectState(pool, {
      objectType: "deal", objectId: 503, eventId: "9043", eventType: "deal.deletion",
      occurredAt: "2026-07-20T13:00:00.000Z", tombstone: true,
    });
    const rows = (await model("models/staging/stg_crm__deals.sql")).sort((a, b) =>
      String(a.deal_id).localeCompare(String(b.deal_id)),
    );
    expect(rows.map((r) => r.deal_id)).toEqual(["D-1", "D-2"]);
    expect(rows[0]).toMatchObject({ amount_cents: "125000", currency: "USD", company_id: "C-A" });
    expect(rows[1].amount_cents).toBeNull();
    expect(rows[1].currency).toBeNull();
  });
});

describe("merge_edges — re-sourced from company.merge thin events", () => {
  const seedMergePair = async (): Promise<void> => {
    // The winner's OLD object (fetched while alive) …
    await insertHubObjectState(pool, {
      objectType: "company", objectId: 100, eventId: "8001",
      occurredAt: "2026-07-20T09:00:00.000Z",
      properties: { name: "DEMO One", domain: "one.example.com", hs_manifest_id: "C-0001" },
    });
    // … the merged-away duplicate (fetched while alive) …
    await insertHubObjectState(pool, {
      objectType: "company", objectId: 121, eventId: "8002",
      occurredAt: "2026-07-20T09:30:00.000Z",
      properties: { name: "DEMO One Inc", domain: "one.example.com", hs_manifest_id: "C-0021" },
    });
    // … the merge, minting a NEW survivor, whose own hydration carries the winner's key.
    await insertHubMergeEvent(pool, {
      eventId: "8003", occurredAt: "2026-07-20T10:00:00.000Z",
      primaryObjectId: 100, mergedObjectIds: [121], newObjectId: 150,
    });
    // The survivor hydrates through the merge event's OWN event id (F-1b) — snapshot
    // only; the raw row is the merge event above.
    await insertHubObjectState(pool, {
      objectType: "company", objectId: 150, eventId: "8003", eventType: "company.merge",
      occurredAt: "2026-07-20T10:00:00.000Z", skipRawEvent: true,
      properties: { name: "DEMO One", domain: "one.example.com", hs_manifest_id: "C-0001", hs_merged_object_ids: "100;121" },
    });
  };

  it("BOTH inputs map to the survivor in business-key space: the merged-away id gains an edge to the winner's key, and the winner's self-edge is excluded", async () => {
    await seedMergePair();
    const rows = await model("models/identity/merge_edges.sql");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from_id: "C-0021", to_id: "C-0001" });
  });

  it("the walk strands no staged id: every staged company reaches a terminal canonical and the 2→1 collapse holds through int_crm__canonical_companies", async () => {
    await seedMergePair();
    await pool.query(`create table t_companies as select * from (${loadModel("models/staging/stg_crm__companies.sql")}) m`);
    await pool.query(`create table t_edges as select * from (${loadModel("models/identity/merge_edges.sql")}) m`);
    const walk = await pool.query(
      loadModel("models/identity/int_crm__canonical_companies.sql", {
        stg_crm__companies: "t_companies",
        merge_edges: "t_edges",
      }),
    );
    const canon = new Map(walk.rows.map((r) => [r.company_id, r.canonical_id]));
    expect(walk.rows.every((r) => !r.is_cycle)).toBe(true);
    expect(canon.get("C-0021")).toBe("C-0001");
    expect(canon.get("C-0001")).toBe("C-0001");
    expect(new Set(walk.rows.map((r) => r.canonical_id)).size).toBe(1); // 2 staged keys → 1 canonical
  });

  it("a consumed id that was never hydrated while alive translates to no edge — and never staged, so nothing strands", async () => {
    // Only the survivor's snapshot exists; the consumed 999 has no snapshot at all.
    await insertHubMergeEvent(pool, {
      eventId: "8010", occurredAt: "2026-07-20T10:00:00.000Z",
      primaryObjectId: 998, mergedObjectIds: [999], newObjectId: 997,
    });
    await insertHubObjectState(pool, {
      objectType: "company", objectId: 997, eventId: "8010", eventType: "company.merge",
      occurredAt: "2026-07-20T10:00:00.000Z", skipRawEvent: true,
      properties: { name: "DEMO Z", domain: "z.example.com", hs_manifest_id: "C-Z", hs_merged_object_ids: "998;999" },
    });
    const rows = await model("models/identity/merge_edges.sql");
    expect(rows).toHaveLength(0);
  });
});

describe("stg_support__tickets — the casebus supplied-* arm", () => {
  const T0 = "2026-07-20T10:00:00.000Z";
  const seedCase = async (
    caseId: string,
    opts?: { priority?: string; email?: string; closedAfterMinutes?: number; updatePriorityTo?: string },
  ): Promise<void> => {
    await insertCaseEvent(pool, `cev_${caseId}_c`, "case.created", T0, {
      case_id: caseId,
      requester_id: `R-${caseId}`,
      subject: `DEMO Case ${caseId}`,
      priority: opts?.priority ?? "normal",
      origin: "email",
      SuppliedEmail: opts?.email ?? "help@acme-1.example.com",
      SuppliedName: "DEMO Caller",
      SuppliedCompany: "DEMO Acme Group 1",
      ContactId: null,
    });
    if (opts?.updatePriorityTo) {
      await insertCaseEvent(pool, `cev_${caseId}_u`, "case.updated", "2026-07-20T11:00:00.000Z", {
        case_id: caseId, requester_id: `R-${caseId}`,
        field: "priority", old_value: opts?.priority ?? "normal", new_value: opts.updatePriorityTo,
      });
    }
    if (opts?.closedAfterMinutes !== undefined) {
      await insertCaseEvent(pool, `cev_${caseId}_x`, "case.closed", "2026-07-20T12:00:00.000Z", {
        case_id: caseId, requester_id: `R-${caseId}`,
        resolution: "solved", resolution_minutes: opts.closedAfterMinutes,
      });
    }
  };

  it("the CREATE's supplied-* fields are the entity evidence: email/name/company verbatim, domain derived from SuppliedEmail", async () => {
    await seedCase("T-1");
    const rows = await model("models/staging/stg_support__tickets.sql");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ticket_id: "T-1",
      requester_id: "R-T-1",
      requester_email: "help@acme-1.example.com",
      requester_name: "DEMO Caller",
      company_name: "DEMO Acme Group 1",
      domain: "acme-1.example.com",
      priority: "normal",
      status: "open",
    });
    expect(rows[0].solved_at).toBeNull();
  });

  it("case.closed makes the case solved: solved_at = created_at + resolution_minutes, and SLA due derives from the org-side policy (high 24h, else 72h)", async () => {
    await seedCase("T-2", { priority: "high", closedAfterMinutes: 30 * 60 }); // solved after 30h
    const rows = await model("models/staging/stg_support__tickets.sql");
    expect(rows).toHaveLength(1);
    const created = new Date(T0).getTime();
    expect(rows[0].status).toBe("solved");
    expect(new Date(rows[0].solved_at as string).getTime()).toBe(created + 30 * 60 * 60_000);
    expect(new Date(rows[0].sla_due_at as string).getTime()).toBe(created + 24 * 3_600_000);
    // 30h resolution on a 24h SLA: the mart's breach predicate (solved_at > sla_due_at) holds.
    expect(new Date(rows[0].solved_at as string) > new Date(rows[0].sla_due_at as string)).toBe(true);
  });

  it("a changed-only case.updated frame with field=priority moves the staged priority (CDC: updates carry deltas, supplied-* fields are never re-sent)", async () => {
    await seedCase("T-3", { priority: "normal", updatePriorityTo: "high" });
    const rows = await model("models/staging/stg_support__tickets.sql");
    expect(rows).toHaveLength(1);
    expect(rows[0].priority).toBe("high");
    expect(rows[0].requester_email).toBe("help@acme-1.example.com"); // intake evidence survives the update
  });
});

describe("stg_billing__* — the stripefeed envelope arm", () => {
  it("customers stage from customer.created data.object verbatim (id/name/domain/email)", async () => {
    await insertStripeEvent(pool, "evt_c1", "customer.created", "2026-07-20T10:00:00.000Z", {
      id: "B-1", object: "customer", name: "DEMO Acme Group 1", domain: "acme-1.example.com", email: "c1@acme-1.example.com",
    });
    const rows = await model("models/staging/stg_billing__customers.sql");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ customer_id: "B-1", name: "DEMO Acme Group 1", domain: "acme-1.example.com", email: "c1@acme-1.example.com" });
  });

  it("invoices stage from invoice.finalized; a charge.succeeded for the invoice makes it 'paid', otherwise it stays the open 'created' state", async () => {
    await insertStripeEvent(pool, "evt_i1", "invoice.finalized", "2026-07-20T10:00:00.000Z", {
      id: "I-1", object: "invoice", customer_id: "B-1", amount_cents: 5000, currency: "USD",
    });
    await insertStripeEvent(pool, "evt_i2", "invoice.finalized", "2026-07-20T10:01:00.000Z", {
      id: "I-2", object: "invoice", customer_id: "B-1", amount_cents: 7000, currency: "USD",
    });
    await insertStripeEvent(pool, "evt_ch1", "charge.succeeded", "2026-07-20T10:02:00.000Z", {
      id: "CH-1", object: "charge", invoice_id: "I-1", customer_id: "B-1", amount_cents: 5000, currency: "USD",
    });
    const rows = (await model("models/staging/stg_billing__invoices.sql")).sort((a, b) =>
      String(a.invoice_id).localeCompare(String(b.invoice_id)),
    );
    expect(rows.map((r) => [r.invoice_id, r.status])).toEqual([
      ["I-1", "paid"],
      ["I-2", "created"],
    ]);
    expect(rows[0]).toMatchObject({ customer_id: "B-1", amount_cents: "5000", currency: "USD" });
  });

  it("payments stage from charge.succeeded/charge.failed with the charge id as payment identity", async () => {
    await insertStripeEvent(pool, "evt_ch2", "charge.succeeded", "2026-07-20T10:00:00.000Z", {
      id: "CH-2", object: "charge", invoice_id: "I-9", customer_id: "B-2", amount_cents: 100, currency: "USD",
    });
    await insertStripeEvent(pool, "evt_ch3", "charge.failed", "2026-07-20T10:01:00.000Z", {
      id: "CH-3", object: "charge", invoice_id: "I-9", customer_id: "B-2", amount_cents: 100, currency: "USD",
    });
    const rows = (await model("models/staging/stg_billing__payments.sql")).sort((a, b) =>
      String(a.payment_id).localeCompare(String(b.payment_id)),
    );
    expect(rows.map((r) => [r.payment_id, r.status])).toEqual([
      ["CH-2", "succeeded"],
      ["CH-3", "failed"],
    ]);
    expect(rows[0]).toMatchObject({ customer_id: "B-2", invoice_id: "I-9" });
  });
});

// ── F-1c fix round (cold review I-3): a merge event whose SURVIVOR snapshot is missing
// (its hydration DLQ'd — a named, operator-visible runtime state) drops its edges
// silently: both consumed companies keep staging from their pre-merge snapshots as two
// separate stale canonicals, and every structural dbt test stays green because they all
// key off edges that EXIST. The singular test pinned here makes that shape RED at build
// time: every company.merge event's newObjectId must resolve to a translatable
// (non-tombstone) company snapshot. ─────────────────────────────────────────────────────
describe("assert_merge_survivors_translate — untranslatable merge survivors red the build", () => {
  const testSql = () => loadModel("tests/assert_merge_survivors_translate.sql");

  it("a merge whose survivor hydrated (the healthy shape) raises nothing", async () => {
    await insertHubObjectState(pool, {
      objectType: "company", objectId: 100, eventId: "8101",
      occurredAt: "2026-07-20T09:00:00.000Z",
      properties: { name: "DEMO One", domain: "one.example.com", hs_manifest_id: "C-0001" },
    });
    await insertHubMergeEvent(pool, {
      eventId: "8102", occurredAt: "2026-07-20T10:00:00.000Z",
      primaryObjectId: 100, mergedObjectIds: [121], newObjectId: 150,
    });
    await insertHubObjectState(pool, {
      objectType: "company", objectId: 150, eventId: "8102", eventType: "company.merge",
      occurredAt: "2026-07-20T10:00:00.000Z", skipRawEvent: true,
      properties: { name: "DEMO One", domain: "one.example.com", hs_manifest_id: "C-0001", hs_merged_object_ids: "100;121" },
    });
    const res = await pool.query(testSql());
    expect(res.rows).toEqual([]);
  });

  it("the reviewer's probe shape — consumed snapshots exist, survivor snapshot missing — returns the offending merge event", async () => {
    // Both consumed objects hydrated while alive; the merge event's own hydration never
    // landed (DLQ'd), so newObjectId=997 has no snapshot to translate through.
    await insertHubObjectState(pool, {
      objectType: "company", objectId: 500, eventId: "8110",
      occurredAt: "2026-07-20T09:00:00.000Z",
      properties: { name: "DEMO Five", domain: "five.example.com", hs_manifest_id: "C-0005" },
    });
    await insertHubObjectState(pool, {
      objectType: "company", objectId: 525, eventId: "8111",
      occurredAt: "2026-07-20T09:30:00.000Z",
      properties: { name: "DEMO Five Inc", domain: "five.example.com", hs_manifest_id: "C-0025" },
    });
    await insertHubMergeEvent(pool, {
      eventId: "8112", occurredAt: "2026-07-20T10:00:00.000Z",
      primaryObjectId: 500, mergedObjectIds: [525], newObjectId: 997,
    });
    const res = await pool.query(testSql());
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ event_id: "8112", new_object_id: "997" });
    // And the silent-loss consequence the test exists to catch, stated as data: the
    // edge really is dropped while both consumed keys keep staging separately.
    const edges = await pool.query(`select * from (${loadModel("models/identity/merge_edges.sql")}) m`);
    expect(edges.rows).toEqual([]);
    const staged = await pool.query(`select company_id from (${loadModel("models/staging/stg_crm__companies.sql")}) m order by company_id`);
    expect(staged.rows.map((r) => r.company_id)).toEqual(["C-0005", "C-0025"]);
  });

  it("a survivor whose only snapshot is a TOMBSTONE is equally untranslatable and equally red", async () => {
    await insertHubMergeEvent(pool, {
      eventId: "8120", occurredAt: "2026-07-20T10:00:00.000Z",
      primaryObjectId: 600, mergedObjectIds: [625], newObjectId: 650,
    });
    await insertHubObjectState(pool, {
      objectType: "company", objectId: 650, eventId: "8120", eventType: "company.merge",
      occurredAt: "2026-07-20T10:00:00.000Z", skipRawEvent: true, tombstone: true,
    });
    const res = await pool.query(testSql());
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ event_id: "8120" });
  });
});
