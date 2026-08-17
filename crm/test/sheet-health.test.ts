// Sheet foundation — the health SURFACES: the digest and the reconcile listing must
// distinguish (a) sheet unreachable, (b) permission revoked, (c) rows missing, because the
// ACTIONS differ: wait (nothing lost) / re-share with the named service account / restore
// the row. One wording per state, shared by both surfaces (`sheetHealthLines`), so the two
// can never drift apart.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { freshCrmDb, TEST_TENANT } from "./helpers/crmdb.js";
import {
  sheetHealth,
  sheetHealthLines,
  classifySheetFailure,
  sheetReadCode,
  type SheetHealth,
} from "../src/sheet-adopt.js";
import { SheetApiError } from "../src/sheet-client.js";
import { formatDigestSubject, formatDigestBody, type DigestCounts } from "../src/digest.js";
import { reconcile, formatReconcile } from "../src/reconcile.js";

let admin: pg.Pool;
let crm: pg.Pool;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  cleanup = db.cleanup;
}, 120_000);

afterEach(async () => {
  await admin.query("delete from crm.sheet_reads");
  await admin.query("delete from crm.follow_ups");
  await admin.query("delete from crm.contacts");
  await admin.query("delete from crm.linked_sheets");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

const SA = "switchboard-sheets@robot.example.com";

function health(overrides: Partial<SheetHealth>): SheetHealth {
  return {
    linkedSheetId: randomUUID(),
    spreadsheetId: "sheet-x",
    label: "Her list",
    lastReadAt: new Date("2026-08-17T01:00:00Z"),
    lastReadOk: true,
    lastReadDetail: "ok: adopted 0",
    rowsMissing: 0,
    ...overrides,
  };
}

describe("the three states carry three different sentences", () => {
  it("unreachable says paused-and-nothing-lost; revoked names the account; missing counts rows", async () => {
    const unreachable = sheetHealthLines(
      health({
        lastReadOk: false,
        lastReadDetail: classifySheetFailure(new Error("ETIMEDOUT"), SA),
      }),
    ).join("\n");
    const revoked = sheetHealthLines(
      health({
        lastReadOk: false,
        lastReadDetail: classifySheetFailure(new SheetApiError(403, "forbidden"), SA),
      }),
    ).join("\n");
    const missing = sheetHealthLines(health({ rowsMissing: 3 })).join("\n");

    // (a) unreachable: her action is to WAIT — so it must say nothing was lost.
    expect(unreachable).toContain("paused");
    expect(unreachable).toContain("nothing has been lost");
    expect(unreachable).not.toContain(SA);

    // (b) revoked: her action is to RE-SHARE — so it must name the account to share with.
    expect(revoked).toContain(SA);
    expect(revoked).toContain("Re-share");
    expect(revoked).not.toContain("nothing has been lost");

    // (c) rows missing: her action is on the SHEET — blocked, not removed.
    expect(missing).toContain("3 contact(s)");
    expect(missing).toContain("blocked, not removed");

    // Three states, three sentences — none reuses another's wording.
    expect(new Set([unreachable, revoked, missing]).size).toBe(3);
  });

  it("classifies 403/404 as revoked and everything else as unreachable", () => {
    expect(sheetReadCode(classifySheetFailure(new SheetApiError(403, "x"), SA))).toBe(
      "permission_revoked",
    );
    expect(sheetReadCode(classifySheetFailure(new SheetApiError(404, "x"), SA))).toBe(
      "permission_revoked",
    );
    expect(sheetReadCode(classifySheetFailure(new SheetApiError(500, "x"), SA))).toBe(
      "unreachable",
    );
    expect(sheetReadCode(classifySheetFailure(new Error("ECONNRESET"), SA))).toBe("unreachable");
  });
});

describe("the digest carries the sheet's state", () => {
  const base: DigestCounts = {
    waiting: 0,
    expiringSoon: 0,
    expiredUnseen: 0,
    newContacts: 0,
    blocked: [],
    bouncesRecorded: 0,
    stuck: 0,
  };

  it("subject: a healthy sheet stays out; each unhealthy state names itself", () => {
    expect(formatDigestSubject({ ...base, sheet: health({}) })).toBe("Nothing needs you today");
    expect(
      formatDigestSubject({
        ...base,
        sheet: health({ lastReadOk: false, lastReadDetail: "unreachable: ETIMEDOUT" }),
      }),
    ).toBe("sheet unreachable");
    expect(
      formatDigestSubject({
        ...base,
        sheet: health({
          lastReadOk: false,
          lastReadDetail: classifySheetFailure(new SheetApiError(403, "x"), SA),
        }),
      }),
    ).toBe("sheet access revoked");
    expect(
      formatDigestSubject({
        ...base,
        sheet: health({ lastReadOk: false, lastReadDetail: "breaker_drift: 6 of 6 …" }),
      }),
    ).toBe("sheet import halted");
  });

  it("body: renders the shared per-state sentences", () => {
    const body = formatDigestBody(
      {
        ...base,
        sheet: health({
          lastReadOk: false,
          lastReadDetail: classifySheetFailure(new SheetApiError(403, "x"), SA),
          rowsMissing: 2,
        }),
      },
      { queueUrl: "http://q", localDate: "2026-08-17", sinceLabel: "since yesterday" },
    );
    expect(body).toContain(SA);
    expect(body).toContain("Re-share");
    expect(body).toContain("2 contact(s)");
    expect(body).toContain("blocked, not removed");
  });
});

describe("the health rows come off the database through each surface's own role", () => {
  it("sheetHealth works on the CRM pool (the digest's role — 021's SELECT grant, end to end)", async () => {
    const s = await admin.query<{ id: string }>(
      `insert into crm.linked_sheets (tenant_id, spreadsheet_id, label)
       values ($1, 'sheet-live', 'Her list') returning id`,
      [TEST_TENANT],
    );
    await admin.query(
      `insert into crm.sheet_reads (tenant_id, linked_sheet_id, ok, detail)
       values ($1, $2, false, $3)`,
      [TEST_TENANT, s.rows[0].id, classifySheetFailure(new SheetApiError(403, "x"), SA)],
    );
    // A missing-row block rides the count.
    const c = await admin.query<{ id: string }>(
      `insert into crm.contacts (tenant_id, channel, source, linked_sheet_id, row_ref)
       values ($1, 'call', 'manual', $2, 'r1') returning id`,
      [TEST_TENANT, s.rows[0].id],
    );
    await admin.query(
      `insert into crm.follow_ups (contact_id, due_date, blocked_reason)
       values ($1, current_date, 'sheet_row_missing')`,
      [c.rows[0].id],
    );

    const viaCrm = await sheetHealth(crm, TEST_TENANT);
    expect(viaCrm).toHaveLength(1);
    expect(viaCrm[0].lastReadOk).toBe(false);
    expect(viaCrm[0].rowsMissing).toBe(1);
    expect(sheetReadCode(viaCrm[0].lastReadDetail)).toBe("permission_revoked");
  });

  it("reconcile lists the sheet with the same sentences", async () => {
    const s = await admin.query<{ id: string }>(
      `insert into crm.linked_sheets (tenant_id, spreadsheet_id, label)
       values ($1, 'sheet-rec', 'Her list') returning id`,
      [TEST_TENANT],
    );
    await admin.query(
      `insert into crm.sheet_reads (tenant_id, linked_sheet_id, ok, detail)
       values ($1, $2, false, 'unreachable: ETIMEDOUT')`,
      [TEST_TENANT, s.rows[0].id],
    );
    const report = await reconcile(admin);
    expect(report.sheetHealth).toHaveLength(1);
    const text = formatReconcile(report);
    expect(text).toContain("linked sheets: 1");
    expect(text).toContain("paused");
    expect(text).toContain("nothing has been lost");
  });
});
