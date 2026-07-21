import { existsSync, readFileSync } from "node:fs";
import type pg from "pg";

interface LedgerEntry {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: unknown;
  seq: number;
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
