import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHmac } from "node:crypto";

export const GENESIS_HASH = "0".repeat(64);

// NOTE: DEFAULT_LEDGER_HMAC_KEY is intentionally duplicated in ingest/src/reconcile.ts
// (separate workspace, must not cross-import). Keep both copies in sync if the key or
// chaining scheme changes.
// Shared secret keying the ledger's hash chain. Demo-only default, printed in the open —
// real deployments must set LEDGER_HMAC_KEY to a proper secret held only by the ledger
// writer and the auditor, kept separate from the log file itself. Without a key, anyone
// who can write the ledger file can mutate an entry and re-chain everything after it,
// so the "tamper-evident" claim only holds against parties who don't hold the key.
export const DEFAULT_LEDGER_HMAC_KEY = "demo-ledger-key";

export type LedgerEntry = {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: unknown;
  seq: number;
  prev_hash: string;
  hash: string;
};

export type LedgerEntryInput = Omit<LedgerEntry, "prev_hash" | "hash">;

// Canonical hash: HMAC-SHA256(key, prev_hash + canonical JSON of the entry sans hash
// fields). Keyed (not a plain hash) so a party without the key cannot mutate an entry
// and re-chain forward: recomputing HMAC values requires the secret, not just the
// algorithm. NOTE: this hashing function is intentionally duplicated in
// ingest/src/reconcile.ts (chain verification) because reconcile lives in a
// separate workspace and must not import from mocks/core (a test-only mock service
// package). Keep both copies in sync if the canonicalization or key handling changes.
function canonicalHash(prevHash: string, entryWithoutHash: LedgerEntryInput, key: string): string {
  const canonical = JSON.stringify({
    event_id: entryWithoutHash.event_id,
    event_type: entryWithoutHash.event_type,
    occurred_at: entryWithoutHash.occurred_at,
    data: entryWithoutHash.data,
    seq: entryWithoutHash.seq,
  });
  return createHmac("sha256", key).update(prevHash + canonical).digest("hex");
}

// Ledger writes are single-process in the mock (no concurrent writers), so reading
// the last line synchronously to determine prev_hash is safe. This is not
// concurrency-safe across processes.
function lastHash(path: string): string {
  if (!existsSync(path)) return GENESIS_HASH;
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  if (lines.length === 0) return GENESIS_HASH;
  const last = JSON.parse(lines[lines.length - 1]) as LedgerEntry;
  return last.hash;
}

export function appendToLedger(
  path: string,
  entry: LedgerEntryInput,
  key: string = process.env.LEDGER_HMAC_KEY ?? DEFAULT_LEDGER_HMAC_KEY,
): LedgerEntry {
  mkdirSync(dirname(path), { recursive: true });
  const prev_hash = lastHash(path);
  const hash = canonicalHash(prev_hash, entry, key);
  const full: LedgerEntry = { ...entry, prev_hash, hash };
  appendFileSync(path, JSON.stringify(full) + "\n", "utf8");
  return full;
}

export function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function verifyLedgerChain(
  path: string,
  key: string = process.env.LEDGER_HMAC_KEY ?? DEFAULT_LEDGER_HMAC_KEY,
): { ok: boolean; brokenAt?: number } {
  const entries = readLedger(path);
  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const lineNo = i + 1;
    if (entry.prev_hash !== expectedPrev) {
      return { ok: false, brokenAt: lineNo };
    }
    const recomputed = canonicalHash(entry.prev_hash, entry, key);
    if (recomputed !== entry.hash) {
      return { ok: false, brokenAt: lineNo };
    }
    expectedPrev = entry.hash;
  }
  return { ok: true };
}
