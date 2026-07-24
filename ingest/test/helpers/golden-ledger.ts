import { writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { GENESIS_HASH } from "../../src/reconcile.js";

// Byte-for-byte the algorithm in mocks/crm/src/ledger.ts (canonicalHash + appendToLedger).
// Reproduced here (not imported) because ingest must not depend on the mock package — the
// same reason reconcile.ts duplicates canonicalHash. Cross-compat is proven by construction:
// this is the writer's algorithm; verifyLedgerChain is the ingest copy. Shared by
// ledger-verify.test.ts (unit cases) and properties.test.ts (truncation property).

export interface LedgerEntry {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: unknown;
  seq: number;
  prev_hash: string;
  hash: string;
}

export type EntryInput = Omit<LedgerEntry, "prev_hash" | "hash">;

export function writerHash(prevHash: string, entry: EntryInput, key: string): string {
  const canonical = JSON.stringify({
    event_id: entry.event_id,
    event_type: entry.event_type,
    occurred_at: entry.occurred_at,
    data: entry.data,
    seq: entry.seq,
  });
  return createHmac("sha256", key).update(prevHash + canonical).digest("hex");
}

export function writeGoldenLedger(path: string, inputs: EntryInput[], key: string): LedgerEntry[] {
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
