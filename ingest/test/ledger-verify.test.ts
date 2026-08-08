import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyLedgerChain, DEFAULT_LEDGER_HMAC_KEY } from "../src/reconcile.js";
// Test-code cross-import is the file's own convention (see the helper note): the drift
// coverage below must run BOTH deliberately-duplicated copies over identical fixtures.
import { verifyLedgerChain as writerVerifyLedgerChain } from "../../mocks/core/src/ledger.js";
import { writeGoldenLedger, type EntryInput } from "./helpers/golden-ledger.js";

// The ingest verifier (reconcile.ts) carries its OWN copy of canonicalHash, pinned to
// the mocks/core writer only by keep-in-sync comments. reconcile.test.ts exercises set
// equality but never the hash chain, so a silent drift between the two canonicalHash
// copies would pass every unit test and only surface in chaos.sh. This file is the
// direct coverage: helpers/golden-ledger.ts writes its fixture with the REAL
// `appendToLedger` from mocks/core, and these tests assert the INGEST verifier accepts
// what the actual writer produces. (It once reproduced the algorithm as a third local
// copy, which made these tests self-certifying — see the helper's own note.) If either
// copy drifts (canonicalization, HMAC input order, key handling), these tests go red.

const GOLDEN: EntryInput[] = [1, 2, 3, 4].map((i) => ({
  event_id: `evt-${i}`,
  event_type: "company.updated",
  occurred_at: new Date(2026, 0, i).toISOString(),
  data: { id: `c-${i}`, name: `Company ${i}` },
  seq: i,
}));

let dir: string;
let ledgerPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ingest-ledger-verify-"));
  ledgerPath = join(dir, "ledger.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ingest verifyLedgerChain (the copy chaos.sh actually runs)", () => {
  it("accepts a valid keyed ledger written with the default demo key", () => {
    writeGoldenLedger(ledgerPath, GOLDEN, DEFAULT_LEDGER_HMAC_KEY);
    expect(verifyLedgerChain(ledgerPath, DEFAULT_LEDGER_HMAC_KEY)).toEqual({ ok: true });
  });

  it("cross-compat: a ledger built with the mocks WRITER's exact algorithm verifies under the ingest copy (proves the two canonicalHash copies agree)", () => {
    const key = "cross-workspace-secret";
    writeGoldenLedger(ledgerPath, GOLDEN, key);
    // If reconcile.ts's canonicalHash drifted from the writer's (field order,
    // JSON shape, HMAC input, key usage), this recomputation would mismatch → ok:false.
    expect(verifyLedgerChain(ledgerPath, key)).toEqual({ ok: true });
  });

  it("rejects a tampered entry with {ok:false, brokenAt:n}", () => {
    const key = "cross-workspace-secret";
    const entries = writeGoldenLedger(ledgerPath, GOLDEN, key);
    // Mutate entry #3's payload but keep its stored hash — classic tamper.
    entries[2] = { ...entries[2], data: { id: "c-3", name: "TAMPERED" } };
    writeFileSync(ledgerPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    expect(verifyLedgerChain(ledgerPath, key)).toEqual({ ok: false, brokenAt: 3 });
  });

  it("rejects the whole chain under the wrong key", () => {
    writeGoldenLedger(ledgerPath, GOLDEN, "the-real-key");
    expect(verifyLedgerChain(ledgerPath, "a-different-key")).toEqual({ ok: false, brokenAt: 1 });
  });
});

// Debt-burn A6 (L1-G7's verifier half). The HMAC chain proves the FILE was not rewritten
// — it cannot catch a buggy WRITER, which produces a perfectly-chained log of whatever it
// was told to append (RFC 9162 layers positional/index verification on top of Merkle
// hashing for exactly this reason). The two predicates: `seq` strictly increasing (a
// restarted mock forks the logical stream and re-counts from 1 — previously verified
// clean) and `event_id` unique within the chain. Both copies of the verifier must agree,
// so every fixture below runs through BOTH.
describe("writer-bug predicates (debt-burn A6): a perfectly-chained log can still lie about position and identity", () => {
  const key = DEFAULT_LEDGER_HMAC_KEY;
  const COPIES = [
    ["ingest verifier (src/reconcile.ts)", verifyLedgerChain],
    ["writer-side verifier (mocks/core/src/ledger.ts)", writerVerifyLedgerChain],
  ] as const;

  const entry = (id: string, seq: number): EntryInput => ({
    event_id: id,
    event_type: "company.updated",
    occurred_at: new Date(2026, 0, 1).toISOString(),
    data: { id },
    seq,
  });

  for (const [name, verify] of COPIES) {
    describe(name, () => {
      it("rejects the restarted-writer fork: seq re-counts from 1 mid-chain, hashes all valid, brokenAt names the fork line", () => {
        writeGoldenLedger(ledgerPath, [entry("evt-a", 1), entry("evt-b", 2), entry("evt-c", 1), entry("evt-d", 2)], key);
        expect(verify(ledgerPath, key)).toEqual({ ok: false, brokenAt: 3 });
      });

      it("rejects an equal (non-strictly-increasing) seq at its line", () => {
        writeGoldenLedger(ledgerPath, [entry("evt-a", 1), entry("evt-b", 2), entry("evt-c", 2)], key);
        expect(verify(ledgerPath, key)).toEqual({ ok: false, brokenAt: 3 });
      });

      it("rejects a duplicate event_id even when seq keeps increasing — the chain happily hashed it", () => {
        writeGoldenLedger(ledgerPath, [entry("evt-a", 1), entry("evt-b", 2), entry("evt-a", 3)], key);
        expect(verify(ledgerPath, key)).toEqual({ ok: false, brokenAt: 3 });
      });

      it("accepts strictly-increasing but NON-CONTIGUOUS seq — monotonicity is the invariant, not density", () => {
        writeGoldenLedger(ledgerPath, [entry("evt-a", 1), entry("evt-b", 5), entry("evt-c", 9)], key);
        expect(verify(ledgerPath, key)).toEqual({ ok: true });
      });

      it("a non-numeric seq is a broken chain at that line, never a NaN comparison that silently passes", () => {
        writeGoldenLedger(ledgerPath, [entry("evt-a", 1), entry("evt-b", "two" as never), entry("evt-c", 3)], key);
        expect(verify(ledgerPath, key)).toEqual({ ok: false, brokenAt: 2 });
      });
    });
  }

  it("cross-copy drift coverage: both copies return IDENTICAL verdicts over every predicate fixture", () => {
    const fixtures: EntryInput[][] = [
      [entry("evt-a", 1), entry("evt-b", 2), entry("evt-c", 1)],
      [entry("evt-a", 1), entry("evt-b", 2), entry("evt-b", 3)],
      [entry("evt-a", 1), entry("evt-b", 7)],
      [entry("evt-a", 3), entry("evt-b", 2)],
    ];
    for (const inputs of fixtures) {
      writeGoldenLedger(ledgerPath, inputs, key);
      expect(writerVerifyLedgerChain(ledgerPath, key)).toEqual(verifyLedgerChain(ledgerPath, key));
    }
  });
});

describe("torn-line crash-safety: file corruption is a verdict, never a throw", () => {
  // A crash or disk-full mid-append leaves a partially-written final line. The verifier
  // must report that as a broken chain at that line — a corrupted file that throws is
  // indistinguishable from a verifier bug, and chaos.sh's reconciliation would die
  // instead of failing loudly with a location. (Truncation at an EXACT line boundary
  // yields a valid shorter chain — inherent to append-only logs; reconcile's ledger-vs-raw
  // count comparison is what catches that case.)
  const key = DEFAULT_LEDGER_HMAC_KEY;

  it("a final line torn mid-append yields {ok:false, brokenAt:lastLine}", () => {
    writeGoldenLedger(ledgerPath, GOLDEN, key);
    const full = readFileSync(ledgerPath, "utf8");
    // Cut the last entry's JSON off mid-string, no trailing newline — crash mid-write.
    writeFileSync(ledgerPath, full.trimEnd().slice(0, -25), "utf8");
    expect(() => verifyLedgerChain(ledgerPath, key)).not.toThrow();
    expect(verifyLedgerChain(ledgerPath, key)).toEqual({ ok: false, brokenAt: 4 });
  });

  it("a garbage (unparseable) line mid-file breaks the chain at that line", () => {
    const entries = writeGoldenLedger(ledgerPath, GOLDEN, key);
    const lines = entries.map((e) => JSON.stringify(e));
    lines[1] = '{"event_id":"evt-2","event_ty'; // torn where line 2 was
    writeFileSync(ledgerPath, lines.join("\n") + "\n", "utf8");
    expect(() => verifyLedgerChain(ledgerPath, key)).not.toThrow();
    expect(verifyLedgerChain(ledgerPath, key)).toEqual({ ok: false, brokenAt: 2 });
  });

  it("a line that parses to a non-object ('null') is a broken chain, not a TypeError", () => {
    const entries = writeGoldenLedger(ledgerPath, GOLDEN, key);
    const lines = entries.map((e) => JSON.stringify(e));
    lines[2] = "null"; // valid JSON, not a ledger entry — .prev_hash access would throw
    writeFileSync(ledgerPath, lines.join("\n") + "\n", "utf8");
    expect(() => verifyLedgerChain(ledgerPath, key)).not.toThrow();
    expect(verifyLedgerChain(ledgerPath, key)).toEqual({ ok: false, brokenAt: 3 });
  });
});
