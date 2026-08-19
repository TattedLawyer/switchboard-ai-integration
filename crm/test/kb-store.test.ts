// Knowledge-base store pins — the retrieval query's FAIL-CLOSED contract (plan C6).
//
// Full retrieval (ranked answers in the agent's hands) is a later task; the FILTER is
// not. "NULL embedding = not retrievable" is part of the store's contract from the first
// migration, because the alternative — a chunk ranked by a vector it does not have, or
// ranked as if distance NULL were nearness — is exactly the silent-degradation family
// this repo pins everywhere else.
//
// Everything runs through the pools whose roles production uses: entries authored via
// `switchboard_approval`, chunks written and searched via `switchboard_crm` (crmdb.ts's
// own header on forged-state fixtures).
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import { freshCrmDb, TEST_TENANT } from "./helpers/crmdb.js";
import { searchGeneralChunks, toVectorLiteral } from "../src/kb/store.js";

let admin: pg.Pool;
let crm: pg.Pool;
let approval: pg.Pool;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  const u = new URL(db.url);
  u.username = "switchboard_approval";
  u.password = "switchboard_approval";
  approval = new pg.Pool({ connectionString: u.toString(), max: 2 });
  approval.on("error", () => {});
  cleanup = async () => {
    await approval.end().catch(() => {});
    await db.cleanup();
  };
}, 120_000);

afterEach(async () => {
  await admin.query("delete from kb.general_chunks");
  await admin.query("delete from kb.general_entries");
  await admin.query("delete from approval.users");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

async function seedAuthor(): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `insert into approval.users (email) values ('marisol@example.com') returning id`,
  );
  return r.rows[0].id;
}

async function seedEntry(
  authorId: string,
  o: { tenant?: string; status?: "active" | "retired"; title?: string } = {},
): Promise<string> {
  const r = await approval.query<{ id: string }>(
    `insert into kb.general_entries (tenant_id, kind, title, body, status, created_by)
     values ($1, 'listing', $2, 'body text', $3, $4) returning id`,
    [o.tenant ?? TEST_TENANT, o.title ?? "Alabang Hills 3BR", o.status ?? "active", authorId],
  );
  return r.rows[0].id;
}

/** A unit vector along one axis — cosine distance to a same-axis query is 0, to an
 *  orthogonal one it is 1, so ranking assertions are exact, not fuzzy. */
function axis(i: number): number[] {
  const v = new Array<number>(1024).fill(0);
  v[i] = 1;
  return v;
}

async function seedChunk(
  entryId: string,
  ordinal: number,
  text: string,
  embedding: number[] | null,
): Promise<string> {
  const r = await crm.query<{ id: string }>(
    `insert into kb.general_chunks (entry_id, ordinal, text, embedding, embedded_at, content_hash)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [
      entryId,
      ordinal,
      text,
      embedding === null ? null : toVectorLiteral(embedding),
      embedding === null ? null : new Date().toISOString(),
      createHash("sha256").update(text).digest("hex"),
    ],
  );
  return r.rows[0].id;
}

describe("kb store: retrieval is fail-closed and identity-scoped", () => {
  // P8. mutation, RUN ✅ 2026-08-19: deleted `and c.embedding is not null` from the
  //     store query -> `Tests  1 failed | 4 passed (5)` — AssertionError: expected
  //     [ …(2) ] to deeply equal [ Array(1) ], the NULL-embedding chunk's id appearing
  //     second in the result (ranked NULLS-LAST, but RETURNED — the exact silent
  //     degradation the filter exists to forbid). Restored, green (5/5).
  it("a chunk with NULL embedding is NOT retrievable, however large the limit", async () => {
    const author = await seedAuthor();
    const entry = await seedEntry(author);
    const embedded = await seedChunk(entry, 0, "embedded chunk", axis(0));
    await seedChunk(entry, 1, "pending chunk — embedder has not run", null);

    const hits = await searchGeneralChunks(crm, TEST_TENANT, axis(0), 50);
    expect(hits.map((h) => h.chunkId)).toEqual([embedded]);
  });

  it("a retired entry's chunks are not retrievable, even fully embedded", async () => {
    const author = await seedAuthor();
    const live = await seedEntry(author, { title: "live" });
    const retired = await seedEntry(author, { status: "retired", title: "retired" });
    const liveChunk = await seedChunk(live, 0, "live text", axis(0));
    await seedChunk(retired, 0, "retired text", axis(0));

    const hits = await searchGeneralChunks(crm, TEST_TENANT, axis(0), 50);
    expect(hits.map((h) => h.chunkId)).toEqual([liveChunk]);
  });

  it("another tenant's knowledge never crosses — the filter is in the query, not the caller", async () => {
    const author = await seedAuthor();
    const mine = await seedEntry(author);
    const other = await seedEntry(author, { tenant: "00000000-0000-0000-0000-0000000000c2" });
    const myChunk = await seedChunk(mine, 0, "mine", axis(0));
    await seedChunk(other, 0, "theirs", axis(0));

    const hits = await searchGeneralChunks(crm, TEST_TENANT, axis(0), 50);
    expect(hits.map((h) => h.chunkId)).toEqual([myChunk]);
  });

  it("ranks by cosine distance, nearest first, with the distance surfaced", async () => {
    const author = await seedAuthor();
    const entry = await seedEntry(author);
    const near = await seedChunk(entry, 0, "near", axis(0));
    const far = await seedChunk(entry, 1, "far", axis(1));

    const hits = await searchGeneralChunks(crm, TEST_TENANT, axis(0), 50);
    expect(hits.map((h) => h.chunkId)).toEqual([near, far]);
    expect(hits[0].distance).toBeCloseTo(0, 5);
    expect(hits[1].distance).toBeCloseTo(1, 5);
  });

  it("refuses a query vector of the wrong arity BEFORE touching SQL, with a named error", async () => {
    await expect(searchGeneralChunks(crm, TEST_TENANT, [0.1, 0.2, 0.3], 5)).rejects.toThrow(
      /1024/,
    );
  });
});
