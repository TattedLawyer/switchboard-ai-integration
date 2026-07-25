import { rmSync } from "node:fs";
import { appendToLedger } from "../../../mocks/core/src/ledger.js";
import type { LedgerEntry, LedgerEntryInput } from "../../../mocks/core/src/ledger.js";

// B1 (truth-in-claims): this helper previously REPRODUCED the writer's algorithm as a
// third local copy — which made the "cross-compat" tests self-certifying: they wrote
// with the local copy and verified with the ingest copy, so the actual mock writer
// could drift with every test green (external audit 2026-07-25, F1). Now the golden
// ledger is written by the REAL `appendToLedger` from mocks/core: if the mock's
// canonicalization or key handling ever diverges from the ingest verifier, every
// golden-ledger test goes red. Cross-workspace imports are a test-code convention here
// (backfill.test.ts set the precedent); the no-cross-import rule protects src only.

export type { LedgerEntry };
export type EntryInput = LedgerEntryInput;

export function writeGoldenLedger(path: string, inputs: EntryInput[], key: string): LedgerEntry[] {
  rmSync(path, { force: true });
  return inputs.map((input) => appendToLedger(path, input, key));
}
