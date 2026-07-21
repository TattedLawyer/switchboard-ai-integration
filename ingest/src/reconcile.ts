import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

// NOTE: this hashing function is intentionally duplicated from mocks/crm/src/ledger.ts
// (canonicalHash) because reconcile lives in the ingest workspace and must not import
// from mocks/crm (a test-only mock service package). Keep both copies in sync if the
// canonicalization changes.
function canonicalHash(prevHash: string, entry: LedgerEntry): string {
  const canonical = JSON.stringify({
    event_id: entry.event_id,
    event_type: entry.event_type,
    occurred_at: entry.occurred_at,
    data: entry.data,
    seq: entry.seq,
  });
  return createHash("sha256").update(prevHash + canonical).digest("hex");
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
