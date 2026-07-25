import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp, type SourceEvent } from "../src/server.js";
import { ingestEvent } from "../src/ingest-event.js";
import { secretForSource, signBody, verifySignature } from "../src/hmac.js";
import { jsonbUnstorableReason, MAX_JSONB_NESTING_DEPTH } from "../src/quarantine.js";
import { createQueue, enqueueEvent, startWorker, fetchDlq, queueName } from "../src/queue.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyLedgerChain, DEFAULT_LEDGER_HMAC_KEY } from "../src/reconcile.js";
import { writeGoldenLedger, type EntryInput } from "./helpers/golden-ledger.js";

// Property-based claim-pinning suite (fast-check). Every property here is expected GREEN at
// HEAD: these lock the L1-G1/G2/G5/G9 fix classes (and the ledger torn-write fix) so they
// cannot regress — they are not exploratory. Known-failing invariants (e.g. normalization
// idempotence) are deliberately NOT pinned here — a green suite must not hide known reds.
// The public list lives in KNOWN-ISSUES.md at the repo root, with the phase where each
// gets fixed.
//
// SEED: fixed so CI runs are reproducible — every fc.assert below uses this seed, so a failure
// report's counterexample can be replayed exactly with `{ seed: SEED, path: "<reported path>" }`.
const SEED = 20260721;

let pool: pg.Pool;
let cleanup: () => Promise<void>;
let connectionString: string;

beforeAll(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
  // Rebuild the ephemeral DB's connection string for pg-boss (queue.test.ts pattern).
  const originalUrl = process.env.DATABASE_URL;
  if (!originalUrl) throw new Error("DATABASE_URL is required");
  const dbResult = await pool.query("select current_database() as db");
  connectionString = originalUrl.replace(/\/[^/?]*(\?|$)/, `/${dbResult.rows[0].db}$1`);
});

afterAll(async () => {
  await cleanup();
});

// ---------------------------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------------------------

// Strings with the jsonb-unstorable nasties injected: real U+0000 NUL, lone UTF-16 surrogates
// (high and low, bare and embedded), plus well-formed astral pairs (emoji) that must NOT be
// false-positived, and generic/full-unicode strings.
const nastyString = fc.oneof(
  { weight: 3, arbitrary: fc.string() },
  { weight: 2, arbitrary: fc.string({ unit: "binary" }) },
  {
    weight: 3,
    arbitrary: fc
      .tuple(fc.string(), fc.constantFrom("\u0000", "\ud800", "\udc00", "\udbff"), fc.string())
      .map(([a, m, b]) => a + m + b),
  },
  { weight: 1, arbitrary: fc.constant("\u0000") },
  { weight: 1, arbitrary: fc.constant("pair 👍 ok") }, // well-formed astral pair
  { weight: 1, arbitrary: fc.constant("literal \\u0000 text") }, // 6-char escape TEXT, jsonb-safe
);

// Bounded-depth JSON tree with nasty strings in BOTH values and object keys. Depth stays small
// (≤ 8) so the independent recursive oracle in property 4 can walk it safely even after the
// deep-chain wrapper below adds up to ~1500 more levels.
const { tree: nastyJsonTree } = fc.letrec<{ tree: unknown; arr: unknown[]; obj: Record<string, unknown> }>(
  (tie) => ({
    tree: fc.oneof(
      { maxDepth: 8, depthSize: "small" },
      fc.constant(null),
      fc.boolean(),
      fc.integer(),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      nastyString,
      tie("arr"),
      tie("obj"),
    ),
    arr: fc.array(tie("tree"), { maxLength: 4 }),
    obj: fc.dictionary(nastyString, tie("tree"), { maxKeys: 4 }),
  }),
);

// Wrap a value in `depth` nested containers, built iteratively (never recursively).
function wrapDeep(base: unknown, depth: number, kind: "array" | "object"): unknown {
  let v = base;
  for (let i = 0; i < depth; i++) v = kind === "array" ? [v] : { k: v };
  return v;
}

// ---------------------------------------------------------------------------------------------
// Property 1 — ingest-boundary totality (pins the L1-G2/G5/G9 fix class)
// ---------------------------------------------------------------------------------------------

describe("property 1: ingest-boundary totality — validly-signed requests never 5xx, every 202 persists somewhere", () => {
  // Schema-valid events whose contents are arbitrary nasties: exercises the stored path AND the
  // unstorable-divert path from inside otherwise-valid events.
  const validEventArb = fc.record({
    event_id: fc.oneof(
      fc.string({ minLength: 1 }),
      nastyString.filter((s) => s.length > 0),
    ),
    event_type: fc.string({ minLength: 1 }),
    occurred_at: fc.string(),
    data: fc.dictionary(nastyString, nastyJsonTree, { maxKeys: 4 }),
  });

  // Deep nesting near and past the depth bound (up to ~1500), built iteratively.
  const deepPayloadArb = fc
    .record({
      depth: fc.oneof(
        fc.integer({ min: 900, max: 1500 }),
        fc.constantFrom(999, 1000, 1001, 1002),
      ),
      kind: fc.constantFrom("array" as const, "object" as const),
      leaf: fc.oneof(fc.string(), fc.constant("\u0000")),
      wrapInEvent: fc.boolean(),
    })
    .map(({ depth, kind, leaf, wrapInEvent }) => {
      const nested = wrapDeep(leaf, depth, kind);
      return wrapInEvent
        ? {
            event_id: `deep-${kind}-${depth}`,
            event_type: "company.updated",
            occurred_at: new Date().toISOString(),
            data: { nested },
          }
        : nested;
    });

  // Schema-valid events with jsonb-SAFE contents: guarantees the stored-path branch actually
  // fires often (nasty-laden validEventArb payloads almost always divert to quarantine).
  const cleanEventArb = fc.record({
    event_id: fc.string({ minLength: 1, unit: "grapheme-ascii" }),
    event_type: fc.string({ minLength: 1, unit: "grapheme-ascii" }),
    occurred_at: fc.string({ unit: "grapheme-ascii" }),
    data: fc.dictionary(fc.string({ unit: "grapheme-ascii" }), fc.string({ unit: "grapheme-ascii" }), {
      maxKeys: 4,
    }),
  });

  const payloadArb = fc.oneof(
    { weight: 3, arbitrary: fc.jsonValue() }, // generic JSON, incl. non-object roots
    { weight: 3, arbitrary: nastyJsonTree },
    { weight: 3, arbitrary: validEventArb },
    { weight: 3, arbitrary: cleanEventArb },
    { weight: 2, arbitrary: deepPayloadArb },
    { weight: 1, arbitrary: fc.dictionary(nastyString, fc.jsonValue(), { maxKeys: 5 }) }, // unicode/nasty root keys
  );

  it("never 5xx; 202 ⇒ payload landed in raw.raw_events or ingest.quarantine (never neither)", async () => {
    const app = createIngestApp(pool); // direct mode, like nul-payload.test.ts
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      await fc.assert(
        fc.asyncProperty(payloadArb, async (payload) => {
          // JSON.stringify escapes NUL and lone surrogates into their \uXXXX wire form — the
          // exact bytes a real source would sign and send. Depth ≤ ~1500 stringifies fine
          // (V8's recursive stringify dies near ~6.6k).
          const rawBody = JSON.stringify(payload);
          const qBefore = (
            await pool.query("select count(*)::int as n from ingest.quarantine where source='crm'")
          ).rows[0].n as number;

          const res = await fetch(`http://127.0.0.1:${port}/webhooks/crm`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-switchboard-signature": signBody(rawBody, secretForSource("crm")),
            },
            body: rawBody,
          });

          // Totality: a validly-signed request must never 5xx while the DB is healthy.
          expect(res.status).toBeLessThan(500);

          if (res.status === 202) {
            const body = (await res.json()) as { stored?: boolean; quarantined?: boolean };
            if (body.quarantined === true) {
              const qAfter = (
                await pool.query("select count(*)::int as n from ingest.quarantine where source='crm'")
              ).rows[0].n as number;
              expect(qAfter).toBe(qBefore + 1);
            } else {
              // stored ⇒ schema passed ⇒ payload.event_id is a string; the row must exist.
              expect(body).toEqual({ stored: true });
              const eventId = (payload as { event_id: string }).event_id;
              const raw = await pool.query(
                "select 1 from raw.raw_events where source='crm' and event_id=$1",
                [eventId],
              );
              expect(raw.rowCount).toBe(1);
            }
          } else {
            // Only non-202 outcome reachable for a signed request: express's strict JSON parser
            // rejecting a non-object/array root (or malformed body) → clean 400.
            expect(res.status).toBe(400);
          }
        }),
        { seed: SEED, numRuns: 40 },
      );
    } finally {
      srv.close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// Property 2 — delivery-multiset dedup invariance
// ---------------------------------------------------------------------------------------------

describe("property 2: dedup is multiset-delivery invariant", () => {
  let runCounter = 0;
  const MAX_N = 15;
  const MAX_MULTISET = MAX_N * 3;

  const p2Arb = fc.record({
    n: fc.integer({ min: 1, max: MAX_N }),
    copies: fc.array(fc.integer({ min: 1, max: 3 }), { minLength: MAX_N, maxLength: MAX_N }),
    orderKeys: fc.array(fc.integer(), { minLength: MAX_MULTISET, maxLength: MAX_MULTISET }),
    names: fc.array(fc.string(), { minLength: MAX_N, maxLength: MAX_N }),
  });

  it("N distinct events delivered 1-3x each (shuffled; sequential then concurrent re-delivery) ⇒ exactly N rows, first-accepted payloads, redelivery is a no-op", async () => {
    await fc.assert(
      fc.asyncProperty(p2Arb, async ({ n, copies, orderKeys, names }) => {
        const run = ++runCounter;
        const prefix = `p2-r${run}-`;

        // Multiset: event i appears copies[i] times; copy k of event i differs in data.copy so
        // "payloads = first-accepted" is observable, not vacuous.
        type Entry = { evt: SourceEvent; i: number };
        const entries: Entry[] = [];
        for (let i = 0; i < n; i++) {
          for (let k = 0; k < copies[i]; k++) {
            entries.push({
              i,
              evt: {
                event_id: `${prefix}e${i}`,
                event_type: "company.updated",
                occurred_at: "2026-07-21T00:00:00.000Z",
                data: { name: names[i], copy: k },
              },
            });
          }
        }
        // Shuffle deterministically from generated sort keys (stable tiebreak by index).
        const shuffled = entries
          .map((e, idx) => ({ e, key: orderKeys[idx], idx }))
          .sort((a, b) => a.key - b.key || a.idx - b.idx)
          .map((x) => x.e);

        // First-accepted payload per event = first occurrence in the sequential delivery order.
        const firstAccepted = new Map<number, SourceEvent>();
        for (const { evt, i } of shuffled) if (!firstAccepted.has(i)) firstAccepted.set(i, evt);

        // Phase A: sequential delivery of the whole multiset.
        for (const { evt } of shuffled) await ingestEvent(pool, "crm", evt);

        // Exactly N rows for this run's events, payload = first-accepted for each.
        const rows = await pool.query(
          "select event_id, payload, md5(payload::text) as hash from raw.raw_events where source='crm' and event_id like $1 order by event_id",
          [`${prefix}%`],
        );
        expect(rows.rowCount).toBe(n);
        const hashesAfterA = new Map<string, string>();
        for (const row of rows.rows) {
          const i = Number((row.event_id as string).slice(prefix.length + 1));
          expect(row.payload).toEqual(firstAccepted.get(i));
          hashesAfterA.set(row.event_id, row.hash);
        }

        // Phase B: re-deliver the ENTIRE multiset concurrently (Promise.all). Every call must
        // resolve "duplicate" and nothing may change.
        const results = await Promise.all(shuffled.map(({ evt }) => ingestEvent(pool, "crm", evt)));
        expect(results.every((r) => r === "duplicate")).toBe(true);

        const rowsAfterB = await pool.query(
          "select event_id, md5(payload::text) as hash from raw.raw_events where source='crm' and event_id like $1",
          [`${prefix}%`],
        );
        expect(rowsAfterB.rowCount).toBe(n);
        for (const row of rowsAfterB.rows) {
          expect(row.hash).toBe(hashesAfterA.get(row.event_id));
        }
      }),
      { seed: SEED, numRuns: 25 },
    );
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// Property 3 — HMAC exactness + never-throws (pure, high numRuns)
// ---------------------------------------------------------------------------------------------

describe("property 3: verifySignature ⇔ header === signBody at a fixed in-window timestamp, and never throws", () => {
  // A3: signatures are timestamped. A fixed t (with nowSeconds pinned to it) keeps the
  // property deterministic — clock ticks between sign and verify can't flake it, and the
  // window logic itself is pinned by replay-window.test.ts.
  const T = 1_753_400_000;
  const anyString = fc.oneof(
    fc.string(),
    fc.string({ unit: "binary" }),
    nastyString,
    fc.constant(""),
  );

  // Header strategy: sometimes the exact correct signature, sometimes a corruption of it
  // (one flipped char / truncation / case-flip / prefix-strip — wrong length and non-hex
  // included), sometimes a fully arbitrary string.
  const headerStrategyArb = fc.oneof(
    fc.record({ mode: fc.constant("correct" as const) }),
    fc.record({ mode: fc.constant("arbitrary" as const), s: anyString }),
    fc.record({ mode: fc.constant("flip" as const), pos: fc.nat() }),
    fc.record({ mode: fc.constant("truncate" as const), pos: fc.nat() }),
    fc.record({ mode: fc.constant("upcase" as const) }),
    fc.record({ mode: fc.constant("noPrefix" as const) }),
  );

  it("iff-exactness holds and no (body, header, secret) triple throws", () => {
    fc.assert(
      fc.property(anyString, anyString, headerStrategyArb, (body, secret, strat) => {
        const correct = signBody(body, secret, T); // never throws, incl. empty/unicode secrets
        let header: string;
        switch (strat.mode) {
          case "correct":
            header = correct;
            break;
          case "arbitrary":
            header = strat.s;
            break;
          case "flip": {
            const pos = strat.pos % correct.length;
            const c = correct[pos] === "0" ? "1" : "0";
            header = correct.slice(0, pos) + c + correct.slice(pos + 1);
            break;
          }
          case "truncate":
            header = correct.slice(0, strat.pos % correct.length);
            break;
          case "upcase":
            header = correct.toUpperCase(); // same length, hex case mismatch
            break;
          case "noPrefix":
            // Strip the timestamp part — the pre-A3 legacy shape must never verify.
            header = correct.slice(correct.indexOf(",") + 1);
            break;
        }
        const expected = header === signBody(body, secret, T);
        expect(verifySignature(body, header, secret, { nowSeconds: T })).toBe(expected);
        // Missing header is always a clean false, never a throw.
        expect(verifySignature(body, undefined, secret, { nowSeconds: T })).toBe(false);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Property 4 — unstorable-walker soundness (pins the L1-G2 walker)
// ---------------------------------------------------------------------------------------------

describe("property 4: jsonbUnstorableReason is exactly the NUL / lone-surrogate / depth predicate", () => {
  // Independent recursive oracle, mirroring the SPEC of the walker (not its implementation):
  // unstorable ⇔ some string value or object key contains U+0000 or a lone surrogate, or some
  // container sits at depth > MAX_JSONB_NESTING_DEPTH (root = depth 0). Generation is
  // depth-bounded (tree ≤ 8 + wrapper ≤ 1500) so this oracle recurses safely.
  const nastyStr = (s: string): boolean => s.includes("\u0000") || !s.isWellFormed();
  function oracle(v: unknown, depth: number): boolean {
    if (typeof v === "string") return nastyStr(v);
    if (Array.isArray(v)) {
      if (depth > MAX_JSONB_NESTING_DEPTH) return true;
      return v.some((c) => oracle(c, depth + 1));
    }
    if (v !== null && typeof v === "object") {
      if (depth > MAX_JSONB_NESTING_DEPTH) return true;
      return Object.entries(v).some(([k, c]) => nastyStr(k) || oracle(c, depth + 1));
    }
    return false;
  }

  const wrappedArb = fc.record({
    base: nastyJsonTree,
    // Cluster around the depth bound (999/1000/1001/1002 wraps land containers right at it)
    // plus shallow and deep ranges up to ~1500.
    wrapDepth: fc.oneof(
      { weight: 3, arbitrary: fc.integer({ min: 0, max: 30 }) },
      { weight: 2, arbitrary: fc.constantFrom(999, 1000, 1001, 1002) },
      { weight: 2, arbitrary: fc.integer({ min: 900, max: 1500 }) },
    ),
    kind: fc.constantFrom("array" as const, "object" as const),
  });

  it("walker verdict ≡ independent oracle, over nasty trees wrapped up to ~1500 deep", () => {
    fc.assert(
      fc.property(wrappedArb, ({ base, wrapDepth, kind }) => {
        const value = wrapDeep(base, wrapDepth, kind);
        // Never throws (a throw fails the property), and verdict matches the oracle exactly.
        const reason = jsonbUnstorableReason(value);
        expect(reason !== null).toBe(oracle(value, 0));
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it("terminates on wide-flat structures (breadth is not depth)", () => {
    const wideArray = new Array(100_000).fill("x");
    expect(jsonbUnstorableReason(wideArray)).toBeNull();

    const wideObj: Record<string, string> = {};
    for (let i = 0; i < 20_000; i++) wideObj[`k${i}`] = "v";
    expect(jsonbUnstorableReason(wideObj)).toBeNull();

    // One nasty needle in a wide haystack is still found.
    const needle = [...wideArray];
    needle[77_777] = "bad \u0000 nul";
    expect(jsonbUnstorableReason(needle)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Property 5 — batch-failure isolation (pins the L1-G1 perJobResults fix)
// ---------------------------------------------------------------------------------------------

describe("property 5: random poison/healthy batch partitions — healthy ingest exactly once, only poison dead-letters", () => {
  const ev = (id: string): SourceEvent => ({
    event_id: id,
    event_type: "company.updated",
    occurred_at: new Date().toISOString(),
    data: { id: "DEMO-C-0001", name: "DEMO X", domain: "x.example.com" },
  });

  async function pollUntil(cond: () => Promise<boolean>, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await cond()) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`);
  }

  it("for every partition of a 4-8 event batch (≥1 poison, ≥1 healthy)", async () => {
    // ONE boss + one worker set serves all runs (boss start/stop per run would dominate the
    // budget); the poison set and attempt counter are mutable refs the selective pool reads.
    // Ordering matters (queue.test.ts note): createQueue FIRST so the pgboss schema exists
    // before any `delete from pgboss.job` — the property is self-sufficient on a fresh DB.
    const boss = await createQueue(connectionString, {
      retryLimit: 1,
      retryDelay: 1,
      retryBackoff: false,
    });
    try {
      let poisonIds = new Set<string>();
      const attempts = new Map<string, number>();

      // queue.test.ts "(poison batch isolation)" mechanism: delegate to the real pool, count
      // every raw_events insert attempt per event_id, and reject only poison ids — so healthy
      // events in the same batch can succeed while poison ones fail.
      const selectivePool = {
        connect: async () => {
          const client = await pool.connect();
          return {
            query: async (text: string, params?: unknown[]) => {
              if (text.includes("raw.raw_events") && Array.isArray(params)) {
                const eventId = params[1] as string;
                attempts.set(eventId, (attempts.get(eventId) ?? 0) + 1);
                if (poisonIds.has(eventId)) throw new Error("Pool is poisoned for this event");
              }
              return client.query(text, params);
            },
            release: () => client.release(),
          };
        },
      } as unknown as pg.Pool;

      await startWorker(boss, selectivePool);

      let run = 0;
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            size: fc.integer({ min: 4, max: 8 }),
            poisonMask: fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
          }),
          async ({ size, poisonMask }) => {
            run++;
            // Normalize the random partition: at least one poison AND one healthy.
            const mask = poisonMask.slice(0, size);
            if (!mask.includes(true)) mask[0] = true;
            if (!mask.includes(false)) mask[size - 1] = false;

            // Clean slate per run (schema exists: createQueue ran above).
            await pool.query("truncate table raw.raw_events, ingest.outbox restart identity");
            await pool.query("delete from pgboss.job");
            attempts.clear();

            const ids = Array.from({ length: size }, (_, i) => `p5-r${run}-e${i}`);
            poisonIds = new Set(ids.filter((_, i) => mask[i]));
            const healthyIds = ids.filter((id) => !poisonIds.has(id));

            // Enqueue the whole batch in (random-partition) order before the worker's next poll
            // picks it up, so poison and healthy events share fetch batches.
            for (const id of ids) await enqueueEvent(boss, "crm", ev(id));

            // Wait until every poison job dead-lettered and every healthy event is ingested.
            await pollUntil(async () => {
              const dlqIds = new Set((await fetchDlq(boss, 20)).map((j) => j.data.event_id));
              if (![...poisonIds].every((id) => dlqIds.has(id))) return false;
              const n = await pool.query("select count(*)::int as n from raw.raw_events");
              return n.rows[0].n === healthyIds.length;
            }, 20_000);

            // Healthy events ingested — exactly these, no more, no less...
            const raw = await pool.query("select event_id from raw.raw_events order by event_id");
            expect(raw.rows.map((r) => r.event_id).sort()).toEqual([...healthyIds].sort());

            // ...exactly ONCE each (attempt counts, not just idempotent end state)...
            for (const id of healthyIds) expect(attempts.get(id)).toBe(1);

            // ...poison kept its retry policy: initial attempt + 1 retry (retryLimit: 1)...
            for (const id of poisonIds) expect(attempts.get(id)).toBe(2);

            // ...and the DLQ holds EXACTLY the poison ids, all under the crm queue.
            const dlqJobs = await fetchDlq(boss, 20);
            expect(dlqJobs.map((j) => j.data.event_id).sort()).toEqual([...poisonIds].sort());
            expect(dlqJobs.every((j) => j.source === "crm")).toBe(true);

            // Nothing leaked into other sources' queues.
            const others = await pool.query(
              "select count(*)::int as n from pgboss.job where name <> $1 and name <> $2",
              [queueName("crm"), `${queueName("crm")}-dlq`],
            );
            expect(others.rows[0].n).toBe(0);
          },
        ),
        { seed: SEED, numRuns: 8 },
      );
    } finally {
      await boss.stop();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// Property 6 — ledger crash-safety (pins the torn-line verifier fix; pure, no DB)
// ---------------------------------------------------------------------------------------------

describe("property 6: ledger verification is total under arbitrary byte-truncation (torn writes)", () => {
  // The exact oracle: truncating a valid ledger at ANY byte offset must (a) never make the
  // verifier throw, and (b) yield ok:true iff the surviving bytes are a clean prefix of whole
  // lines — a crash at an exact line boundary IS a valid shorter chain (inherent to append-only
  // logs; reconcile's ledger-vs-raw count comparison covers that case), while a mid-line tear
  // must report {ok:false, brokenAt:<the torn line>}. This was a known-failing invariant
  // (KNOWN-ISSUES.md) until the parse-guard fix landed in both verifier copies.
  let p6run = 0;

  it("any truncation offset → never throws; verdict ≡ clean-line-prefix oracle", () => {
    const dir = mkdtempSync(join(tmpdir(), "p6-ledger-"));
    try {
      fc.assert(
        fc.property(
          fc.record({
            n: fc.integer({ min: 1, max: 6 }),
            // Vary line lengths so offsets land in different structural positions (inside
            // strings, hashes, numbers, braces, and exactly on newlines).
            names: fc.array(fc.string({ minLength: 0, maxLength: 40 }), { minLength: 6, maxLength: 6 }),
            cut: fc.nat(),
          }),
          ({ n, names, cut }) => {
            const path = join(dir, `ledger-${++p6run}.jsonl`);
            const inputs: EntryInput[] = Array.from({ length: n }, (_, i) => ({
              event_id: `evt-${i + 1}`,
              event_type: "company.updated",
              occurred_at: new Date(2026, 0, i + 1).toISOString(),
              data: { id: `c-${i + 1}`, name: names[i] },
              seq: i + 1,
            }));
            const entries = writeGoldenLedger(path, inputs, DEFAULT_LEDGER_HMAC_KEY);
            const full = readFileSync(path, "utf8");
            const offset = cut % (full.length + 1); // 0..len inclusive — empty file through untouched
            const truncated = full.slice(0, offset);
            writeFileSync(path, truncated, "utf8");

            const goldenLines = entries.map((e) => JSON.stringify(e));
            const lines = truncated.split("\n").filter(Boolean);
            const cleanPrefix = lines.every((l, i) => l === goldenLines[i]);

            let result: { ok: boolean; brokenAt?: number } | undefined;
            expect(() => {
              result = verifyLedgerChain(path, DEFAULT_LEDGER_HMAC_KEY);
            }).not.toThrow();
            if (cleanPrefix) {
              expect(result).toEqual({ ok: true });
            } else {
              expect(result).toEqual({ ok: false, brokenAt: lines.length });
            }
          },
        ),
        { seed: SEED, numRuns: 150 },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
