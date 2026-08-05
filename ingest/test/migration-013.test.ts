// PRE-3 / #34 — migration 013's functional index, pinned by EXPLAIN.
//
// The entry's near-term half: `deriveState` reads its own memory back out of raw on every
// catchUp cycle, and no functional index on `payload->'data'->>'row_key'` existed, so the
// cost grew with the whole history of the lane. 013 adds
// `(tenant_id, source, ((payload->'data'->>'row_key')), id desc)`.
//
// HOW THIS IS PINNED, AND WHY NOT THE OBVIOUS WAY. Two wrong oracles were rejected first:
//
//   · a TIMING test. On a seeded table it measures machine contention, not plan shape. A
//     flaky pin is a worse oracle than none, and this one would red on a loaded CI runner
//     while a genuinely missing index passed on a quiet one.
//   · a naive `EXPLAIN` asserting the plan does NOT say "Seq Scan". PostgreSQL's own
//     documentation is explicit that "on a table that only occupies one disk page, you'll
//     nearly always get a sequential scan plan whether indexes are available or not" — a
//     test database with a handful of seeded sheet events is exactly that table. That pin
//     would false-red a CORRECTLY built index, or be written loosely enough to pass for
//     the wrong reason.
//
// So: `EXPLAIN` (no ANALYZE — it "displays the query plan devised by the planner ...
// without executing"), run with `enable_seqscan` off for the duration of the assertion —
// the flags are "a crude tool, but useful" for forcing the planner off its preferred plan,
// per the same page — and the assertion is on the INDEX NAME. That measures index
// USABILITY, which is the property the migration actually creates, rather than table size,
// which is the property the naive pin accidentally measures.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";

const INDEX = "idx_raw_events_sheet_row_key";

let pool: pg.Pool;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
  // A handful of rows: enough for the planner to have a choice, deliberately NOT enough
  // to make the plan depend on volume (see the header).
  for (let i = 0; i < 12; i++) {
    await pool.query(
      `insert into raw.raw_events (tenant_id, source, event_id, event_type, payload)
       values ($1, 'sheets', $2, 'sheet.row_upserted', $3::jsonb)`,
      [
        DEFAULT_TENANT_ID,
        `evt-013-${i}`,
        JSON.stringify({ data: { row_key: `rk-${i % 4}`, content_hash: `h${i}` } }),
      ],
    );
  }
  await pool.query("analyze raw.raw_events");
});
afterAll(async () => {
  await cleanup();
});

/** The plan text for `sql`, with the planner's preference for a seq scan removed so the
 *  assertion measures index USABILITY rather than the size of a test table. */
async function planWithoutSeqScan(sql: string, params: unknown[]): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local enable_seqscan = off");
    const res = await c.query(`explain ${sql}`, params);
    await c.query("rollback");
    return res.rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
  } finally {
    c.release();
  }
}

describe("PRE-3 #34 — migration 013's functional index is USABLE by deriveState's latest-state query", () => {
  it("the index exists, on the expression and column order the migration declares", async () => {
    const res = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'raw' and indexname = $1`,
      [INDEX],
    );
    expect(res.rows, `${INDEX} not found — migration 013 did not apply`).toHaveLength(1);
    const def = res.rows[0].indexdef;

    // FIX ROUND (PRE-3 review, Important 1). This block used to assert substrings of the
    // WHOLE `indexdef`, which reads
    //   CREATE INDEX idx_raw_events_sheet_row_key ON raw.raw_events USING btree (...)
    // — it contains the index NAME, and the name contains the substring `row_key`. So the
    // one assertion covering the functional expression was satisfied by the name no matter
    // what the expression was. Demonstrated by the reviewer and reproduced here before
    // fixing: rewriting the migration to `(tenant_id, source, id desc)` — deleting the
    // entire subject of the migration — left all three tests green. A regression straight
    // back to the O(full-history) scan #34 exists to prevent could have landed under this
    // pin.
    //
    // So the name is REMOVED before anything is asserted, and the removal is itself
    // checked. `indexdef` always carries the column list after `USING <method> (`; slicing
    // from there drops the index name and the table name in one move, leaving only the
    // definition an assertion should be reading.
    const columns = def.slice(def.indexOf("USING "));
    expect(columns, `could not isolate the column list from: ${def}`).toMatch(/^USING \w+ \(/);
    // The stripper is load-bearing, so it is pinned: if it ever stops removing the name,
    // every assertion below silently becomes name-satisfiable again.
    expect(columns, "the index NAME is still inside the string being asserted on").not.toContain(INDEX);

    expect(columns).toContain("tenant_id");
    expect(columns).toContain("source");
    // THE ASSERTION THIS TEST EXISTS FOR: the functional EXPRESSION, structurally — the
    // jsonb path operators and both keys, not a bare `row_key` substring. `payload` is the
    // token the name could never have supplied.
    expect(columns).toContain("payload");
    // Postgres renders the expression back with its own casts and parentheses —
    // `(((payload -> 'data'::text) ->> 'row_key'::text))` — so the pattern is written
    // against BOTH operators and BOTH keys in order, tolerant of the casts and the
    // parenthesis the catalog inserts between them, and of nothing else.
    expect(columns).toMatch(/payload\s*->\s*'data'(::text)?\)?\s*->>\s*'row_key'/);
    // `id desc` is what lets `distinct on (row_key) order by row_key, id desc` walk the
    // index in order instead of sorting. Losing it would leave a plausible-looking index
    // that does not serve the query it was built for.
    expect(columns).toMatch(/id DESC/i);
  });

  it("EXPLAIN names the index for the DISTINCT ON latest-state query (assert the NAME, never the absence of 'Seq Scan')", async () => {
    const plan = await planWithoutSeqScan(
      `select distinct on (payload->'data'->>'row_key')
              payload->'data'->>'row_key' as row_key, event_type,
              payload->'data'->>'content_hash' as content_hash
         from raw.raw_events
        where tenant_id = $1 and source = $2
          and event_type in ('sheet.row_upserted', 'sheet.row_deleted')
        order by payload->'data'->>'row_key', id desc`,
      [DEFAULT_TENANT_ID, "sheets"],
    );
    expect(plan, `plan did not reference ${INDEX}:\n${plan}`).toContain(INDEX);
  });

  // Recorded as a LIMIT, not claimed as a fix. The entry stays open for the structural
  // half; this asserts the honest scope of what 013 bought.
  it("the group-by query is only PARTLY served — this is asserted, not glossed", async () => {
    const plan = await planWithoutSeqScan(
      `select event_type,
              payload->'data'->>'row_key' as row_key,
              coalesce(payload->'data'->>'content_hash', payload->'data'->>'last_content_hash') as hash,
              count(*)::int as n
         from raw.raw_events
        where tenant_id = $1 and source = $2
          and event_type in ('sheet.row_upserted', 'sheet.row_deleted')
        group by 1, 2, 3`,
      [DEFAULT_TENANT_ID, "sheets"],
    );
    // The index still serves the tenant/source lookup, so it appears...
    expect(plan).toContain(INDEX);
    // ...but the grouping keys include event_type and the COALESCED hash expression,
    // neither of which the index carries, so a grouping step remains. If this ever stops
    // being true, the KNOWN-ISSUES text claiming the structural half is unpaid is what
    // needs revisiting — which is why the limit is pinned rather than described.
    expect(plan).toMatch(/Aggregate|Group/i);
  });
});
