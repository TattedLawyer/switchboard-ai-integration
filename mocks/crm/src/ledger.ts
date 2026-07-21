import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export const GENESIS_HASH = "0".repeat(64);

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

// Canonical hash: sha256(prev_hash + canonical JSON of the entry sans hash fields).
// NOTE: this hashing function is intentionally duplicated in
// ingest/src/cli/reconcile.ts (chain verification) because reconcile lives in a
// separate workspace and must not import from mocks/crm (a test-only mock service
// package). Keep both copies in sync if the canonicalization changes.
function canonicalHash(prevHash: string, entryWithoutHash: LedgerEntryInput): string {
  const canonical = JSON.stringify({
    event_id: entryWithoutHash.event_id,
    event_type: entryWithoutHash.event_type,
    occurred_at: entryWithoutHash.occurred_at,
    data: entryWithoutHash.data,
    seq: entryWithoutHash.seq,
  });
  return createHash("sha256").update(prevHash + canonical).digest("hex");
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

export function appendToLedger(path: string, entry: LedgerEntryInput): LedgerEntry {
  mkdirSync(dirname(path), { recursive: true });
  const prev_hash = lastHash(path);
  const hash = canonicalHash(prev_hash, entry);
  const full: LedgerEntry = { ...entry, prev_hash, hash };
  appendFileSync(path, JSON.stringify(full) + "\n", "utf8");
  return full;
}

export function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function verifyLedgerChain(path: string): { ok: boolean; brokenAt?: number } {
  const entries = readLedger(path);
  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const lineNo = i + 1;
    if (entry.prev_hash !== expectedPrev) {
      return { ok: false, brokenAt: lineNo };
    }
    const recomputed = canonicalHash(entry.prev_hash, entry);
    if (recomputed !== entry.hash) {
      return { ok: false, brokenAt: lineNo };
    }
    expectedPrev = entry.hash;
  }
  return { ok: true };
}
