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

// NOTE: DEFAULT_LEDGER_HMAC_KEY is intentionally duplicated in mocks/core/src/ledger.ts
// — the real implementation; mocks/crm/src/ledger.ts is only a re-export shim, so a
// sync pointer aimed there would point at nothing. Separate workspace, must not
// cross-import. Keep both copies in sync if the key or chaining scheme changes.
// Shared secret keying the ledger's hash chain. Demo-only default, printed in the open —
// real deployments must set LEDGER_HMAC_KEY to a proper secret held only by the ledger
// writer and the auditor, kept separate from the log file itself. Without a key, anyone
// who can write the ledger file can mutate an entry and re-chain everything after it, so
// the "tamper-evident" claim only holds against parties who don't hold the key. The demo
// key here is public by design — it proves the mechanism (keyed re-chaining is
// detectable), not secrecy.
export const DEFAULT_LEDGER_HMAC_KEY = "demo-ledger-key";

// FAIL CLOSED (A2): with the published demo key, "anyone who can write the file" holds
// the key and a reconcile would verify tampered data clean. The default is only
// reachable behind an explicit ALLOW_DEV_SECRETS=1 opt-in.
// NOTE: duplicated in mocks/core/src/ledger.ts (writer side); keep in sync.
export function ledgerHmacKey(): string {
  const env = process.env.LEDGER_HMAC_KEY;
  if (env) return env;
  if (process.env.ALLOW_DEV_SECRETS === "1") return DEFAULT_LEDGER_HMAC_KEY;
  throw new Error(
    "LEDGER_HMAC_KEY is not set — refusing to fall back to the published demo key. " +
      "Set LEDGER_HMAC_KEY, or set ALLOW_DEV_SECRETS=1 for local demo use only.",
  );
}

// Canonical hash: HMAC-SHA256(key, prev_hash + canonical JSON of the entry sans hash
// fields). Keyed (not a plain hash) so a party without the key cannot mutate an entry
// and re-chain forward: recomputing HMAC values requires the secret, not just the
// algorithm. NOTE: this hashing function is intentionally duplicated from
// mocks/core/src/ledger.ts (canonicalHash) because reconcile lives in the ingest
// workspace and must not import from the mocks (test-only service packages). Keep both
// copies in sync if the canonicalization or key handling changes; ingest/test/
// ledger-verify.test.ts goes red if they drift.
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
  key: string = ledgerHmacKey(),
): { ok: boolean; brokenAt?: number } {
  // Parse per-line with a guard rather than via readLedger: a partially-written final
  // line (crash/disk-full mid-append) or a non-object line is a BROKEN CHAIN at that
  // line — a verdict the caller can act on — never a thrown SyntaxError/TypeError,
  // which would make a corrupted file indistinguishable from a verifier bug. (readLedger
  // stays strict on purpose: the reconcile CLI verifies the chain before reading it, so
  // this is the gate. Truncation at an exact line boundary verifies as a valid shorter
  // chain — inherent to append-only logs; reconcile's count comparison catches it.)
  if (!existsSync(path)) return { ok: true };
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  let expectedPrev = GENESIS_HASH;
  let lastSeq: number | null = null;
  const seenEventIds = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let entry: LedgerEntry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return { ok: false, brokenAt: lineNo };
    }
    if (entry === null || typeof entry !== "object") {
      return { ok: false, brokenAt: lineNo };
    }
    if (entry.prev_hash !== expectedPrev) {
      return { ok: false, brokenAt: lineNo };
    }
    const recomputed = canonicalHash(entry.prev_hash, entry, key);
    if (recomputed !== entry.hash) {
      return { ok: false, brokenAt: lineNo };
    }
    // Writer-bug predicates (debt-burn A6, mirroring RFC 9162's index check layered on
    // top of Merkle hashing): the chain proves the FILE was not rewritten, but a buggy
    // writer produces a perfectly-chained log of whatever it appended — a restarted mock
    // re-counts seq from 1 and forks the logical stream, and a duplicate event_id hashes
    // as happily as a fresh one. seq must be a number and STRICTLY increasing
    // (monotonicity, not density — the type guard also keeps a non-numeric seq from
    // passing every NaN comparison); event_id must be unique within the chain.
    if (typeof entry.seq !== "number" || !Number.isFinite(entry.seq) || (lastSeq !== null && entry.seq <= lastSeq)) {
      return { ok: false, brokenAt: lineNo };
    }
    lastSeq = entry.seq;
    if (typeof entry.event_id !== "string" || seenEventIds.has(entry.event_id)) {
      return { ok: false, brokenAt: lineNo };
    }
    seenEventIds.add(entry.event_id);
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
  /** Ledger-paradigm only (debt-burn A6): entries minus distinct event_ids — the writer
   *  bug the Set-based membership diff used to collapse out of the count comparison
   *  entirely. Defense in depth: the CLI path never sees it nonzero because the chain
   *  verifier now rejects duplicate ids first, but `reconcile()` is public API and must
   *  count honestly on its own. Optional because the other paradigms' reports extend
   *  this shape and have no ledger file. */
  ledgerDuplicates?: number;
}

export async function reconcile(pool: pg.Pool, source: string, ledgerPath: string): Promise<ReconcileReport> {
  const ledgerEntries = readLedger(ledgerPath);
  const ledgerIds = new Set(ledgerEntries.map((e) => e.event_id));
  // The Set is the right shape for the membership diffs below; its SIZE alone would hide
  // a duplicated event_id from the count comparison (debt-burn A6) — count the collapse.
  const ledgerDuplicates = ledgerEntries.length - ledgerIds.size;

  const rawRes = await pool.query<{ event_id: string }>(
    "select event_id from raw.raw_events where source = $1",
    [source],
  );
  const rawIds = rawRes.rows.map((r) => r.event_id);
  const rawIdSet = new Set(rawIds);
  // Structurally always 0: uq_raw_events_source_event_id (migration 003) makes duplicate
  // (source, event_id) inserts impossible, so this proves identity parity (no duplicate
  // rows can exist), not payload parity (it says nothing about whether stored payloads match).
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
    ledgerDuplicates,
  };
}
