// Embed-pass pins — the worker that makes her saved knowledge findable (plan C6).
//
// THE GRANT REALITY IS THE DESIGN CONSTRAINT. `switchboard_crm` holds SELECT on entries,
// SELECT+INSERT on chunks, and column-level UPDATE on (embedding, embedded_at) ONLY — no
// DELETE anywhere in `kb`, no UPDATE on `text`/`content_hash`/`ordinal`. So an edit can
// never be "rewrite the chunk rows": the pass SUPERSEDES — it inserts the new generation
// at fresh ordinals and NULLs the old generation's embeddings in the same transaction,
// and the store's `embedding is not null` filter (kb-store.test.ts's P8) makes NULL mean
// GONE from retrieval. Every pin here runs the pass through the `switchboard_crm` pool,
// because a pass that only works as the owner would be the forged-state fixture class
// crmdb.ts's header names.
//
// A FAKE embedder everywhere the assertion is about pass logic (the real model is
// ~145ms/call); ONE test at the bottom uses the real vendored model end to end, so the
// wiring — prefixes, vector literal, arity, store ranking — is proven against real
// vectors, not stand-ins.
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import { freshCrmDb, TEST_TENANT } from "./helpers/crmdb.js";
import { EMBED_DIM } from "../src/kb/dimensions.js";
import { searchGeneralChunks } from "../src/kb/store.js";
import { runKbEmbedPass, type KbEmbedDeps } from "../src/kb/embed-pass.js";
import { kbIndexStates } from "../src/kb/freshness.js";
import { createEmbedder } from "../src/kb/embedder.js";

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

const sha256 = (t: string): string => createHash("sha256").update(t).digest("hex");

async function seedAuthor(): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `insert into approval.users (email) values ('marisol@example.com') returning id`,
  );
  return r.rows[0].id;
}

/** Authored the way production authors: through the dashboard's role. */
async function seedEntry(
  authorId: string,
  body: string,
  o: { tenant?: string; status?: "active" | "retired"; title?: string } = {},
): Promise<string> {
  const r = await approval.query<{ id: string }>(
    `insert into kb.general_entries (tenant_id, kind, title, body, status, created_by)
     values ($1, 'listing', $2, $3, $4, $5) returning id`,
    [o.tenant ?? TEST_TENANT, o.title ?? "Alabang Hills 3BR", body, o.status ?? "active", authorId],
  );
  return r.rows[0].id;
}

/** Edits the way the dashboard edits: new body, `updated_at` bumped, approval role. */
async function editBody(entryId: string, body: string): Promise<void> {
  await approval.query(
    `update kb.general_entries set body = $2, updated_at = now() where id = $1`,
    [entryId, body],
  );
}

/** Deterministic unit vector from the text's hash — distances are irrelevant to these
 *  pins; presence/absence in the store's results is what is asserted. */
function fakeVec(text: string): number[] {
  const h = createHash("sha256").update(text).digest();
  const v = new Array<number>(EMBED_DIM).fill(0);
  for (let i = 0; i < h.length; i++) v[i] = (h[i] - 127.5) / 128;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

/** Word-count stand-in for the real tokenizer — cheap, monotone in length, good enough
 *  for the chunker to split the deliberately-oversized bodies below. */
const fakeCount = (t: string): number => t.split(/\s+/).filter((w) => w.length > 0).length;

const fakeDeps: KbEmbedDeps = {
  embedPassage: async (t) => fakeVec(t),
  countTokens: fakeCount,
};

const PROBE = fakeVec("probe");

/** Everything currently retrievable for the tenant, by text. */
async function retrievableTexts(): Promise<string[]> {
  const hits = await searchGeneralChunks(crm, TEST_TENANT, PROBE, 100);
  return hits.map((h) => h.text);
}

/** A ~400-word paragraph of unique words: one paragraph fits the 512 budget alone, two
 *  do not, so an N-paragraph body chunks to exactly N chunks under `fakeCount`. */
const para = (tag: string, n = 400): string =>
  Array.from({ length: n }, (_, i) => `${tag}w${i}`).join(" ");

describe("kb embed pass (P1): a new entry becomes chunks, vectors, and a retrieval hit", () => {
  // P1. mutation, RUN ✅ 2026-08-19: embedded_at write removed from the per-chunk publish
  //     UPDATE (embedding still written) -> `Tests 4 failed | 5 passed (9)`: this pin's
  //     `AssertionError: expected null not to be null` at the embedded_at assertion,
  //     plus P3 (`expected +0 to be 1`) and both P7 tests (`expected 'indexing' to be
  //     'indexed'`) — a stamp-less chunk reads as forever-pending. Restored, green (9/9).
  it("chunks the body, embeds each chunk at EMBED_DIM, and the store can find it", async () => {
    const author = await seedAuthor();
    const body = "3BR house-and-lot in Alabang Hills, 250sqm, near Festival Mall.";
    const entry = await seedEntry(author, body);

    const report = await runKbEmbedPass(crm, fakeDeps);

    expect(report.skipped).toBe(false);
    expect(report.candidates).toBe(1);
    expect(report.entriesEmbedded).toBe(1);
    expect(report.chunksEmbedded).toBe(1);
    expect(report.failures).toEqual([]);

    const rows = await crm.query(
      `select ordinal, text, content_hash, embedded_at, vector_dims(embedding) as dims
         from kb.general_chunks where entry_id = $1 order by ordinal`,
      [entry],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].ordinal).toBe(0);
    expect(rows.rows[0].text).toBe(body);
    expect(rows.rows[0].content_hash).toBe(sha256(body));
    expect(rows.rows[0].dims).toBe(EMBED_DIM);
    expect(rows.rows[0].embedded_at).not.toBeNull();

    expect(await retrievableTexts()).toEqual([body]);
  });
});

describe("kb embed pass (P2): re-running with nothing changed writes NOTHING", () => {
  // P2. mutation, RUN ✅ 2026-08-19: the candidate query's narrowing clauses removed
  //     (every active entry a candidate, chunked or not) -> `Tests 2 failed | 7 passed
  //     (9)`: this pin's `AssertionError: expected 1 to be +0` on report.candidates —
  //     the pass re-picked a finished entry every run (and would then re-stamp its
  //     embedded_at, the second half this pin also guards) — plus P6 (`expected 2 to
  //     be 1` on the follow-up pass). Restored, green (9/9).
  it("second pass: zero candidates, identical rows, embedded_at untouched", async () => {
    const author = await seedAuthor();
    const entry = await seedEntry(author, "Office hours are Monday to Friday, 9am to 5pm.");
    await runKbEmbedPass(crm, fakeDeps);

    const before = await crm.query(
      `select id, ordinal, embedded_at::text as at, (embedding is not null) as has
         from kb.general_chunks where entry_id = $1 order by ordinal`,
      [entry],
    );

    const again = await runKbEmbedPass(crm, fakeDeps);
    expect(again.candidates).toBe(0);
    expect(again.entriesEmbedded).toBe(0);
    expect(again.chunksEmbedded).toBe(0);
    expect(again.chunksSuperseded).toBe(0);
    expect(again.failures).toEqual([]);

    const after = await crm.query(
      `select id, ordinal, embedded_at::text as at, (embedding is not null) as has
         from kb.general_chunks where entry_id = $1 order by ordinal`,
      [entry],
    );
    expect(after.rows).toEqual(before.rows);
  });
});

describe("kb embed pass (P3): an edit re-embeds, and the OLD text is GONE from retrieval", () => {
  // P3 — the shrinking-generation pin. 3 chunks edited down to 1: a naive
  //     upsert-by-ordinal leaves ordinals 1..2 embedded with retired text forever.
  //     mutation, RUN ✅ 2026-08-19: the same-transaction supersede UPDATE (old
  //     generation -> embedding NULL) removed from the new-generation path ->
  //     `Tests 1 failed | 8 passed (9)`: `AssertionError: expected [ …(4) ] to have a
  //     length of 1 but got 4` — all three v1 paragraphs still retrievable beside the
  //     v2 body. Restored, green (9/9).
  it("shrinking 3 chunks to 1 leaves no stale high-ordinal chunk retrievable", async () => {
    const author = await seedAuthor();
    const v1 = [para("a"), para("b"), para("c")].join("\n\n");
    const entry = await seedEntry(author, v1);

    const first = await runKbEmbedPass(crm, fakeDeps);
    expect(first.chunksEmbedded).toBe(3);
    expect(await retrievableTexts()).toEqual(expect.arrayContaining([para("a"), para("c")]));

    const v2 = "The corrected listing: price is now ₱17.9M, one paragraph only.";
    await editBody(entry, v2);

    const second = await runKbEmbedPass(crm, fakeDeps);

    // The behavioral pin first: ONLY the new text is retrievable — no v1 paragraph
    // survives, however the counters read.
    const texts = await retrievableTexts();
    expect(texts).toHaveLength(1);
    expect(texts).toEqual([v2]);

    expect(second.candidates).toBe(1);
    expect(second.entriesEmbedded).toBe(1);
    expect(second.chunksEmbedded).toBe(1);
    expect(second.chunksSuperseded).toBe(3);

    // The old rows still EXIST (nothing in kb is ever deleted — explainability), but
    // their embeddings are NULL, which the fail-closed store treats as nonexistence.
    const rows = await crm.query(
      `select count(*)::int as total,
              count(embedding)::int as embedded
         from kb.general_chunks where entry_id = $1`,
      [entry],
    );
    expect(rows.rows[0].total).toBe(4);
    expect(rows.rows[0].embedded).toBe(1);
  });
});

describe("kb embed pass (P4): one bad entry fails alone, fail-closed, and recovers", () => {
  // P4. mutation, RUN ✅ 2026-08-19: the per-entry try/catch removed (one entry's error
  //     aborts the pass) -> `Tests 2 failed | 7 passed (9)`: this test and P7 both died
  //     with `Error: synthetic embed failure` escaping runKbEmbedPass itself — the
  //     healthy entry embedded nothing because the throwing one killed the whole pass,
  //     and report.failures never existed to report it. Restored, green (9/9).
  it("a throwing embedder leaves THAT entry unretrievable while others succeed", async () => {
    const author = await seedAuthor();
    const bad = await seedEntry(author, "boom — this text detonates the fake embedder");
    const goodBody = "The good entry: DMCI condo in Mandaluyong, 2BR.";
    const good = await seedEntry(author, goodBody);

    const throwing: KbEmbedDeps = {
      embedPassage: async (t) => {
        if (t.includes("boom")) throw new Error("synthetic embed failure");
        return fakeVec(t);
      },
      countTokens: fakeCount,
    };

    const report = await runKbEmbedPass(crm, throwing);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].entryId).toBe(bad);
    expect(report.failures[0].error).toMatch(/synthetic embed failure/);
    expect(report.entriesEmbedded).toBe(1);

    // Fail-closed: the bad entry's chunk rows exist (text captured) but carry no vector,
    // so retrieval does not know them.
    expect(await retrievableTexts()).toEqual([goodBody]);
    const badRows = await crm.query(
      `select count(*)::int as total, count(embedding)::int as embedded
         from kb.general_chunks where entry_id = $1`,
      [bad],
    );
    expect(badRows.rows[0].total).toBeGreaterThan(0);
    expect(badRows.rows[0].embedded).toBe(0);

    // And the failure is not a tombstone: the next pass with a working embedder resumes
    // the pending chunks and the entry becomes retrievable.
    const recovery = await runKbEmbedPass(crm, fakeDeps);
    expect(recovery.entriesEmbedded).toBe(1);
    expect(recovery.failures).toEqual([]);
    expect(await retrievableTexts()).toEqual(
      expect.arrayContaining([goodBody, "boom — this text detonates the fake embedder"]),
    );
  });
});

describe("kb embed pass (P5): a retired entry is not embedded and not retrievable", () => {
  // P5. mutation, RUN ✅ 2026-08-19: `e.status = 'active'` removed from the candidate
  //     query -> `Tests 1 failed | 8 passed (9)`: `AssertionError: expected 1 to be +0`
  //     on report.candidates — the retired entry was queued for embedding. (processEntry's
  //     own status re-check is defense in depth for retired-mid-pass; the QUEUE must
  //     still never surface retired entries, which is what this pin holds.) Restored,
  //     green (9/9).
  it("the pass never touches retired entries", async () => {
    const author = await seedAuthor();
    const retired = await seedEntry(author, "A retired listing that must stay dark.", {
      status: "retired",
    });

    const report = await runKbEmbedPass(crm, fakeDeps);
    expect(report.candidates).toBe(0);
    expect(report.entriesEmbedded).toBe(0);

    const rows = await crm.query(
      `select count(*)::int as total from kb.general_chunks where entry_id = $1`,
      [retired],
    );
    expect(rows.rows[0].total).toBe(0);
    expect(await retrievableTexts()).toEqual([]);
  });
});

describe("kb embed pass (P6): bounded per pass; the next pass continues", () => {
  // P6. mutation, RUN ✅ 2026-08-19: `limit $1` dropped from the candidate query ->
  //     `Tests 1 failed | 8 passed (9)`: `AssertionError: expected 3 to be 2` on the
  //     first pass's candidates — one pass consumed the whole backlog regardless of the
  //     bound. Restored, green (9/9).
  it("with 3 entries and limit 2, pass one does 2, pass two does the last", async () => {
    const author = await seedAuthor();
    await seedEntry(author, "Entry one: a lot in Tagaytay.");
    await seedEntry(author, "Entry two: a condo in BGC.");
    await seedEntry(author, "Entry three: a townhouse in Parañaque.");

    const first = await runKbEmbedPass(crm, fakeDeps, { limit: 2 });
    expect(first.candidates).toBe(2);
    expect(first.entriesEmbedded).toBe(2);

    const second = await runKbEmbedPass(crm, fakeDeps, { limit: 2 });
    expect(second.candidates).toBe(1);
    expect(second.entriesEmbedded).toBe(1);

    const third = await runKbEmbedPass(crm, fakeDeps, { limit: 2 });
    expect(third.candidates).toBe(0);

    expect(await retrievableTexts()).toHaveLength(3);
  });
});

describe("kb freshness (P7): the UI's honest 'indexing…' signal", () => {
  // P7. mutation, RUN ✅ 2026-08-19: the staleness disjunct (updated_at vs
  //     max(embedded_at)) hardcoded false in freshness.ts -> `Tests 2 failed | 7 passed
  //     (9)`: `AssertionError: expected 'indexed' to be 'indexing'` for the
  //     edited-but-not-yet-re-embedded entry, in both P7 tests — the UI would show
  //     "indexed" while retrieval still served the pre-edit text. Restored, green (9/9).
  it("reports not_indexed / indexing / indexed, tenant-scoped", async () => {
    const author = await seedAuthor();

    const indexed = await seedEntry(author, "Fully indexed entry.", { title: "indexed" });
    const stale = await seedEntry(author, "Edited entry, first body.", { title: "stale" });
    await runKbEmbedPass(crm, fakeDeps);

    // A pending entry: chunk rows exist, vectors do not (embedder failed mid-pass).
    const pending = await seedEntry(author, "boom pending entry", { title: "pending" });
    await runKbEmbedPass(crm, {
      embedPassage: async (t) => {
        if (t.includes("boom")) throw new Error("synthetic embed failure");
        return fakeVec(t);
      },
      countTokens: fakeCount,
    });

    // Edited after embedding, with NO pass since: retrieval still serves the old
    // vectors — honest state is "indexing" (work owed), never "indexed".
    await editBody(stale, "Edited entry, second body — not yet re-embedded.");

    const fresh = await seedEntry(author, "Brand new, daemon has not run.", { title: "new" });

    await seedEntry(author, "Another tenant's entry.", {
      tenant: "00000000-0000-0000-0000-0000000000c2",
      title: "foreign",
    });

    const states = await kbIndexStates(crm, TEST_TENANT);
    const byId = new Map(states.map((s) => [s.entryId, s]));

    expect(states).toHaveLength(4); // the foreign tenant's entry is not in the answer

    expect(byId.get(fresh)?.state).toBe("not_indexed");
    expect(byId.get(fresh)?.chunkCount).toBe(0);

    expect(byId.get(pending)?.state).toBe("indexing");
    expect(byId.get(pending)?.chunkCount).toBeGreaterThan(0);
    expect(byId.get(pending)?.embeddedCount).toBe(0);

    expect(byId.get(stale)?.state).toBe("indexing");
    expect(byId.get(stale)?.embeddedCount).toBeGreaterThan(0);

    expect(byId.get(indexed)?.state).toBe("indexed");
    expect(byId.get(indexed)?.chunkCount).toBe(1);
    expect(byId.get(indexed)?.embeddedCount).toBe(1);
    expect(byId.get(indexed)?.pendingCount).toBe(0);
  });

  it("after the daemon catches up, indexing states converge to indexed", async () => {
    const author = await seedAuthor();
    const entry = await seedEntry(author, "Converging entry, first body.");
    await runKbEmbedPass(crm, fakeDeps);
    await editBody(entry, "Converging entry, second body.");

    expect((await kbIndexStates(crm, TEST_TENANT))[0].state).toBe("indexing");
    await runKbEmbedPass(crm, fakeDeps);
    expect((await kbIndexStates(crm, TEST_TENANT))[0].state).toBe("indexed");
  });
});

describe("kb embed pass: real embedder end to end", () => {
  // Not a pin on pass logic — the proof that the REAL model, the chunker's real
  // tokenizer, the vector literal, and the store's ranking compose: an authored entry
  // becomes findable BY MEANING, query-prefixed question against passage-prefixed chunk.
  it("an authored listing is found by a paraphrased question, ranked first", async () => {
    const real = await createEmbedder();
    const author = await seedAuthor();
    const listing =
      "3-bedroom house and lot for sale in Alabang Hills Village, 250sqm, ₱18.5M, " +
      "near Festival Mall and Madrigal Business Park.";
    await seedEntry(author, listing, { title: "Alabang Hills 3BR" });
    await seedEntry(author, "Office hours: Monday to Friday, 9am to 5pm, Makati office.", {
      title: "Office hours",
    });

    const report = await runKbEmbedPass(crm, real);
    expect(report.entriesEmbedded).toBe(2);
    expect(report.failures).toEqual([]);

    const q = await real.embedQuery("how much is the three bedroom near Festival Mall?");
    const hits = await searchGeneralChunks(crm, TEST_TENANT, q, 2);
    expect(hits[0].text).toBe(listing);
    expect(hits[0].distance).toBeLessThan(hits[1].distance);
  }, 240_000);
});
