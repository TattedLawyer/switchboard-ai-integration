import { existsSync, readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import type pg from "pg";

interface LedgerEntry {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: unknown;
  seq: number;
  prev_hash: string;
  hash: string;
}

// Minimal, local reader for the ledger file format written by mocks/crm's ledger.ts.
// Kept independent of the mocks/crm workspace since ingest's src should not depend on a
// test-only mock service package.
function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export const GENESIS_HASH = "0".repeat(64);

// NOTE: DEFAULT_LEDGER_HMAC_KEY is intentionally duplicated in mocks/crm/src/ledger.ts
// (separate workspace, must not cross-import). Keep both copies in sync if the key or
// chaining scheme changes.
// Shared secret keying the ledger's hash chain. Demo-only default, printed in the open —
// real deployments must set LEDGER_HMAC_KEY to a proper secret held only by the ledger
// writer and the auditor, kept separate from the log file itself. Without a key, anyone
// who can write the ledger file can mutate an entry and re-chain everything after it, so
// the "tamper-evident" claim only holds against parties who don't hold the key. The demo
// key here is public by design — it proves the mechanism (keyed re-chaining is
// detectable), not secrecy.
export const DEFAULT_LEDGER_HMAC_KEY = "demo-ledger-key";

// Canonical hash: HMAC-SHA256(key, prev_hash + canonical JSON of the entry sans hash
// fields). Keyed (not a plain hash) so a party without the key cannot mutate an entry
// and re-chain forward: recomputing HMAC values requires the secret, not just the
// algorithm. NOTE: this hashing function is intentionally duplicated from
// mocks/crm/src/ledger.ts (canonicalHash) because reconcile lives in the ingest
// workspace and must not import from mocks/crm (a test-only mock service package). Keep
// both copies in sync if the canonicalization or key handling changes.
function canonicalHash(prevHash: string, entry: LedgerEntry, key: string): string {
  const canonical = JSON.stringify({
    event_id: entry.event_id,
    event_type: entry.event_type,
    occurred_at: entry.occurred_at,
    data: entry.data,
    seq: entry.seq,
  });
  return createHmac("sha256", key).update(prevHash + canonical).digest("hex");
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

export interface ReconcileReport {
  ledger: number;
  raw: number;
  missing: string[];
  extra: string[];
  rawDuplicates: number;
}

export async function reconcile(pool: pg.Pool, ledgerPath: string): Promise<ReconcileReport> {
  const ledgerEntries = readLedger(ledgerPath);
  const ledgerIds = new Set(ledgerEntries.map((e) => e.event_id));

  const rawRes = await pool.query<{ event_id: string }>(
    "select event_id from raw.raw_crm_events",
  );
  const rawIds = rawRes.rows.map((r) => r.event_id);
  const rawIdSet = new Set(rawIds);
  // Structurally always 0: uq_raw_crm_events_event_id (migration 002) makes duplicate
  // event_id inserts impossible, so this proves identity parity (no duplicate rows can
  // exist), not payload parity (it says nothing about whether stored payloads match).
  const rawDuplicates = rawIds.length - rawIdSet.size;

  const missing: string[] = [];
  for (const id of ledgerIds) {
    if (!rawIdSet.has(id)) missing.push(id);
  }

  const extra: string[] = [];
  for (const id of rawIdSet) {
    if (!ledgerIds.has(id)) extra.push(id);
  }

  missing.sort();
  extra.sort();

  return {
    ledger: ledgerIds.size,
    raw: rawIdSet.size,
    missing,
    extra,
    rawDuplicates,
  };
}
