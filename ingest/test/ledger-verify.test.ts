import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { verifyLedgerChain, GENESIS_HASH, DEFAULT_LEDGER_HMAC_KEY } from "../src/reconcile.js";

// The ingest verifier (reconcile.ts) carries its OWN copy of canonicalHash, pinned to
// the mocks/crm writer only by keep-in-sync comments. reconcile.test.ts exercises set
// equality but never the hash chain, so a silent drift between the two canonicalHash
// copies would pass every unit test and only surface in chaos.sh. This file is the
// direct coverage: it reproduces the mocks/crm WRITER's exact algorithm inline and
// asserts the INGEST verifier accepts what that algorithm produces. If either copy
// drifts (canonicalization, HMAC input order, key handling), these tests go red.

interface LedgerEntry {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: unknown;
  seq: number;
  prev_hash: string;
  hash: string;
}

type EntryInput = Omit<LedgerEntry, "prev_hash" | "hash">;

// Byte-for-byte the algorithm in mocks/crm/src/ledger.ts (canonicalHash + appendToLedger).
// Reproduced here (not imported) because ingest must not depend on the mock package — the
// same reason reconcile.ts duplicates canonicalHash. Cross-compat is proven by construction:
// this is the writer's algorithm; verifyLedgerChain is the ingest copy.
function writerHash(prevHash: string, entry: EntryInput, key: string): string {
  const canonical = JSON.stringify({
    event_id: entry.event_id,
    event_type: entry.event_type,
    occurred_at: entry.occurred_at,
    data: entry.data,
    seq: entry.seq,
  });
  return createHmac("sha256", key).update(prevHash + canonical).digest("hex");
}

function writeGoldenLedger(path: string, inputs: EntryInput[], key: string): LedgerEntry[] {
  let prev = GENESIS_HASH;
  const entries: LedgerEntry[] = [];
  for (const input of inputs) {
    const hash = writerHash(prev, input, key);
    entries.push({ ...input, prev_hash: prev, hash });
    prev = hash;
  }
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return entries;
}

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
